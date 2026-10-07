import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../server-factory.js";
import { getUpstreamManager } from "./mcp-upstream-manager.js";
import { refreshProxiedTools } from "./mcp-tool-proxy.js";
import { runCodexSessionStartHooks } from "./codex-hooks.js";


const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
function positiveSetting(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}: positive integer required`);
  return value;
}
const SESSION_TTL_MS = positiveSetting("MCP_SESSION_TTL_MS", 1_800_000); // 30m idle
const SESSION_CLEANUP_INTERVAL_MS = parseInt(
  process.env.MCP_SESSION_CLEANUP_MS || "300000",
  10
); // 5m
const SESSION_MAX = positiveSetting("MCP_SESSION_MAX", 512);
const RECOVERY_TIMEOUT_MS = positiveSetting("MCP_SESSION_RECOVERY_TIMEOUT_MS", 10_000);

const lastTransportErrors = new Map<string, string>();
export class SessionCapacityError extends Error {}

/**
 * Gan Mcp-Session-Id vao request truoc khi day cho transport.
 *
 * SDK >=1.29 boc Node transport quanh WebStandardStreamableHTTPServerTransport
 * va dung @hono/node-server de doi IncomingMessage -> fetch Request. Hono dung
 * `incoming.rawHeaders`, KHONG dung `incoming.headers` — nen chi va req.headers
 * la vo tac dung. Phai va ca hai.
 */
function withSessionIdHeader(
  req: Request,
  sessionId: string,
  protocolVersion: string
): Request {
  const headers = {
    ...req.headers,
    "mcp-session-id": sessionId,
    "mcp-protocol-version": protocolVersion,
  };
  const drop = new Set(["mcp-session-id", "mcp-protocol-version"]);
  const raw: string[] = [];
  const existing = req.rawHeaders || [];
  for (let i = 0; i < existing.length; i += 2) {
    if (drop.has(existing[i]?.toLowerCase())) continue;
    raw.push(existing[i], existing[i + 1]);
  }
  raw.push("mcp-session-id", sessionId, "mcp-protocol-version", protocolVersion);
  return Object.assign(req, { headers, rawHeaders: raw });
}

/**
 * ChatGPT (openai-mcp) gui MCP-Protocol-Version moi hon SDK ho tro (vd 2026-07-28)
 * trong request discovery. SDK se tra 400 cho moi request mang version la, lam
 * connector retry vo han. Kep ve version SDK that su ho tro.
 */
function negotiateProtocolVersion(requested: string | undefined): string {
  if (requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

export interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastAccessedAt: number;
  createdAt: number;
  activeRequests: number;
  queuedRequests: number;
  closed: boolean;
}

export interface SessionManagerConfig {
  workspaceRoot: string;
  shellTimeout: number;
  workspaceRoots: string[];
  port: number;
  projectMemoryInstructions?: string;
}

export interface SessionManager {
  get(sessionId: string): McpSession | undefined;
  touch(sessionId: string): void;
  count(): number;
  stats(): { sessions: number; activeRequests: number; queuedRequests: number; recovering: number; maxSessions: number; idleTtlMs: number };
  createNew(req: Request, res: Response, body: unknown): Promise<void>;
  handleExisting(session: McpSession, req: Request, res: Response, body?: unknown): Promise<void>;
  tryRecoverStale(
    staleSessionId: string,
    req: Request,
    res: Response,
    body: unknown
  ): Promise<boolean>;
  sendSessionNotFound(res: Response, requestId?: string | number | null): void;
  sendBadRequest(res: Response, message: string, requestId?: string | number | null): void;
  startCleanup(): void;
  stopCleanup(): void;
}

function extractRequestId(body: unknown): string | number | null {
  if (typeof body !== "object" || body === null) return null;
  if (!("id" in body)) return null;
  const id = (body as { id?: unknown }).id;
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}

async function loopbackMcpPost(
  port: number,
  path: string,
  body: unknown,
  sessionId?: string,
  protocolVersion?: string
): Promise<{ ok: boolean; status: number; sessionId?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;

  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RECOVERY_TIMEOUT_MS),
  });
  // Drain the handshake response so its connection can return to the pool.
  await response.arrayBuffer();
  return {
    ok: response.ok,
    status: response.status,
    sessionId: response.headers.get("mcp-session-id") ?? undefined,
  };
}

export function consumeSessionTransportError(sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  const message = lastTransportErrors.get(sessionId);
  lastTransportErrors.delete(sessionId);
  return message;
}

export function createSessionManager(config: SessionManagerConfig): SessionManager {
const sessionOpChains = new Map<string, Promise<void>>();
async function enqueueSessionOp(sessionId: string, op: () => Promise<void>): Promise<void> {
  const prev = sessionOpChains.get(sessionId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(op);
  sessionOpChains.set(sessionId, run);
  try {
    await run;
  } finally {
    if (sessionOpChains.get(sessionId) === run) {
      sessionOpChains.delete(sessionId);
    }
  }
}

  const sessions = new Map<string, McpSession>();
  const pendingRecoveries = new Map<string, McpSession>();
  const recoveryTasks = new Map<string, Promise<McpSession | undefined>>();
  const uninitialized = new Set<McpSession>();
  const terminated = new Map<string, number>();
  let constructing = 0;
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function touch(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (session) {
      session.lastAccessedAt = Date.now();
    }
  }

  function dispose(session: McpSession): void {
    session.closed = true;
    uninitialized.delete(session);
    getUpstreamManager().unregisterMcpServer(session.server);
    void session.server.close().catch(() => undefined);
    void session.transport.close().catch(() => undefined);
  }

  function removeSession(sessionId: string, reason: string, expected?: McpSession): void {
    const session = sessions.get(sessionId);
    if (!session || (expected && session !== expected)) return;
    sessions.delete(sessionId);
    lastTransportErrors.delete(sessionId);
    dispose(session);
    console.log(`[MCP] Session removed (${reason}): ${sessionId}`);
  }

  function reserveCapacity(): void {
    while (sessions.size + uninitialized.size + constructing >= SESSION_MAX) {
      const idle = [...sessions.entries()]
        .filter(([, s]) => !s.activeRequests && !s.queuedRequests)
        .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)[0];
      if (!idle) throw new SessionCapacityError("MCP session capacity is busy; retry initialization later.");
      removeSession(idle[0], "idle capacity eviction", idle[1]);
    }
  }

  function clearPendingRecovery(sessionId: string): void {
    pendingRecoveries.delete(sessionId);
  }

  async function buildSession(preferredSessionId?: string): Promise<McpSession> {
    reserveCapacity();
    constructing++;
    let session: McpSession | undefined;
    try {
    const hookInstructions = await runCodexSessionStartHooks().catch((error) => {
      console.warn("[MCP] Codex SessionStart hook failed:", error);
      return "";
    });
    const mcpServer = createMcpServer(
      config.workspaceRoot,
      config.shellTimeout,
      config.workspaceRoots,
      false,
      getUpstreamManager(),
      [config.projectMemoryInstructions, hookInstructions].filter(Boolean).join("\n\n")
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: preferredSessionId
        ? () => preferredSessionId
        : () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        if (!session) throw new Error("MCP session construction incomplete");
        session.lastAccessedAt = Date.now();
        uninitialized.delete(session);
        sessions.set(sid, session);
        clearPendingRecovery(sid);
        console.log(`[MCP] Session initialized: ${sid}`);
      },
      onsessionclosed: (sid) => {
        if (sid) {
          terminated.set(sid, Date.now());
          while (terminated.size > SESSION_MAX * 2) terminated.delete(terminated.keys().next().value!);
        }
      },
    });

    transport.onerror = (error) => {
      const sid = transport.sessionId;
      const message = error.message || String(error);
      if (sid) lastTransportErrors.set(sid, message);
    };

    // An SSE stream disconnect does not close the transport. onclose means the
    // entire SDK transport is unusable: never retain it as an active session.
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (!session) return;
      session.closed = true;
      uninitialized.delete(session);
      getUpstreamManager().unregisterMcpServer(mcpServer);
      if (sid) removeSession(sid, "transport closed", session);
    };

    session = { transport, server: mcpServer, lastAccessedAt: Date.now(), createdAt: Date.now(), activeRequests: 0, queuedRequests: 0, closed: false };
    uninitialized.add(session);
    await mcpServer.connect(transport);
    // Native tools must be available immediately. Upstream discovery can spawn
    // local processes or wait on remote MCPs, so publish it when ready instead.
    void refreshProxiedTools(mcpServer, getUpstreamManager())
      .then(() => mcpServer.sendToolListChanged())
      .catch((error) => console.warn("[MCP] Upstream tool refresh failed:", error));

    return session;
    } catch (error) {
      if (session) dispose(session);
      throw error;
    } finally { constructing--; }
  }

  async function warmUpRecoveredSession(
    staleSessionId: string,
    mcpPath: string,
    protocolVersion: string
  ): Promise<boolean> {
    const initResult = await loopbackMcpPost(
      config.port,
      mcpPath,
      {
        jsonrpc: "2.0",
        id: "__session_recovery_init__",
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "codex-mcp-session-recovery", version: "1.0.0" },
        },
      },
      staleSessionId
    );

    if (!initResult.ok) {
      console.log(
        `[MCP] Recovery initialize failed: HTTP ${initResult.status} for ${staleSessionId}`
      );
      return false;
    }

    const notifyResult = await loopbackMcpPost(
      config.port,
      mcpPath,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      staleSessionId,
      protocolVersion
    );

    if (!notifyResult.ok && notifyResult.status !== 202) {
      console.log(
        `[MCP] Recovery initialized notification failed: HTTP ${notifyResult.status}`
      );
      return false;
    }

    return Boolean(sessions.get(staleSessionId));
  }

  return {
    get(sessionId: string) {
      const session = sessions.get(sessionId);
      return session?.closed ? undefined : session;
    },

    touch,

    count() {
      return sessions.size;
    },
    stats() {
      return { sessions: sessions.size, activeRequests: [...sessions.values()].reduce((n, s) => n + s.activeRequests, 0), queuedRequests: [...sessions.values()].reduce((n, s) => n + s.queuedRequests, 0), recovering: recoveryTasks.size, maxSessions: SESSION_MAX, idleTtlMs: SESSION_TTL_MS };
    },

    sendSessionNotFound(res: Response, requestId: string | number | null = null) {
      const message =
        "Session not found. Server restarted or connector session expired — refresh connector and open a new chat.";
      res.locals.mcpError = message;
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message },
        id: requestId,
      });
    },

    sendBadRequest(res: Response, message: string, requestId: string | number | null = null) {
      res.locals.mcpError = message;
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message },
        id: requestId,
      });
    },

    async createNew(req: Request, res: Response, body: unknown): Promise<void> {
      const headerSessionId = req.headers["mcp-session-id"] as string | undefined;
      let session: McpSession;

      if (headerSessionId && pendingRecoveries.has(headerSessionId)) {
        session = pendingRecoveries.get(headerSessionId)!;
        clearPendingRecovery(headerSessionId);
        console.log(`[MCP] Using pending recovery transport for ${headerSessionId}`);
      } else {
        session = await buildSession();
      }

      const sid = headerSessionId || session.transport.sessionId;
      const run = async () => {
        try {
          await session.transport.handleRequest(req, res, body);
          const activeSid = session.transport.sessionId;
          if (activeSid) touch(activeSid);
          else dispose(session);
        } catch (error) { dispose(session); throw error; }
      };

      if (sid) {
        await enqueueSessionOp(sid, run);
      } else {
        await run();
      }
    },

    async handleExisting(
      session: McpSession,
      req: Request,
      res: Response,
      body?: unknown
    ): Promise<void> {
      const sid =
        session.transport.sessionId || (req.headers["mcp-session-id"] as string | undefined);
      if (sid) touch(sid);
      const run = async () => {
        if (session.closed) {
          res.locals.mcpError = "Session closed; initialize a fresh MCP session.";
          res.status(404).json({ jsonrpc: "2.0", id: extractRequestId(body), error: { code: -32001, message: res.locals.mcpError } });
          return;
        }
        if (req.method !== "GET") session.activeRequests++;
        try { await session.transport.handleRequest(req, res, body); }
        finally {
          if (req.method !== "GET") session.activeRequests--;
          if (sid && !session.closed) touch(sid);
        }
      };
      // GET mo SSE stream song lau: handleRequest chi resolve khi stream dong.
      // Neu day vao hang doi tuan tu, no giu khoa vinh vien va MOI POST sau do
      // (tools/list, tools/call) se treo — deadlock. Chi tuan tu hoa POST/DELETE.
      if (sid && req.method !== "GET") {
        session.queuedRequests++;
        try { await enqueueSessionOp(sid, run); }
        finally { session.queuedRequests--; }
      } else {
        await run();
      }
    },

    async tryRecoverStale(
      staleSessionId: string,
      req: Request,
      res: Response,
      body: unknown
    ): Promise<boolean> {
      if (isInitializeRequest(body) || terminated.has(staleSessionId)) {
        return false;
      }

      const protocolVersion = negotiateProtocolVersion(
        req.headers["mcp-protocol-version"] as string | undefined
      );
      const mcpPath = req.path || "/mcp";

      let recovery = recoveryTasks.get(staleSessionId);
      if (!recovery) {
        recovery = (async () => {
          let pending: McpSession | undefined;
          try {
            const existing = sessions.get(staleSessionId);
            if (existing && !existing.closed) return existing;
            console.log(`[MCP] Attempting session recovery: ${staleSessionId}`);
            pending = await buildSession(staleSessionId);
            pendingRecoveries.set(staleSessionId, pending);
            if (!await warmUpRecoveredSession(staleSessionId, mcpPath, protocolVersion)) {
              removeSession(staleSessionId, "recovery failed", pending);
              dispose(pending);
              return undefined;
            }
            console.log(`[MCP] Session recovered: ${staleSessionId}`);
            return sessions.get(staleSessionId);
          } catch (error) {
            if (pending) { removeSession(staleSessionId, "recovery failed", pending); dispose(pending); }
            if (error instanceof SessionCapacityError) throw error;
            console.warn("[MCP] Recovery handshake failed; request was not executed.");
            return undefined;
          } finally { clearPendingRecovery(staleSessionId); }
        })();
        recoveryTasks.set(staleSessionId, recovery);
      }
      let recovered: McpSession | undefined;
      try { recovered = await recovery; }
      finally { if (recoveryTasks.get(staleSessionId) === recovery) recoveryTasks.delete(staleSessionId); }
      if (!recovered || recovered.closed) return false;

      touch(staleSessionId);
      const patchedReq = withSessionIdHeader(req, staleSessionId, protocolVersion);
      await this.handleExisting(recovered, patchedReq, res, body);
      return true;
    },

    startCleanup() {
      if (cleanupTimer) return;
      cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [sid, session] of sessions) {
          if (!session.activeRequests && !session.queuedRequests && now - session.lastAccessedAt > SESSION_TTL_MS) {
            removeSession(sid, "idle TTL expired", session);
          }
        }
      }, SESSION_CLEANUP_INTERVAL_MS);
      cleanupTimer.unref?.();
    },

    stopCleanup() {
      if (!cleanupTimer) return;
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    },
  };
}

export function isStaleSessionRequest(
  sessionId: string | undefined,
  body: unknown,
  getSession: (id: string) => McpSession | undefined
): boolean {
  return Boolean(sessionId && !getSession(sessionId) && !isInitializeRequest(body));
}

export { extractRequestId, isInitializeRequest };
