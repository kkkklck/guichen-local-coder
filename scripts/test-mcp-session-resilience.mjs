import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";

const root = path.resolve(import.meta.dirname, "..");
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "guichen-session-resilience-"));
const workspace = path.join(fixture, "workspace");
await fs.mkdir(workspace);
await fs.writeFile(path.join(fixture, "upstream.json"), JSON.stringify({ version: 1, servers: [] }));
async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const port = await freePort();
const adminPort = await freePort();
const token = `test-${randomUUID()}`;
const base = `http://127.0.0.1:${port}`;
const endpoint = `${base}/mcp/${token}`;
let child;
let logs = "";
let seq = 1;
async function until(predicate, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Fixture exited during ${label}`);
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const diagnostic = logs.split(/\r?\n/).filter(line => /\[MCP\]|Error:|SECURITY|EADDRINUSE|Default cwd|Local:/.test(line)).slice(-8).join(" ").replace(/sk-[\w-]+/g, "[REDACTED]").split(token).join("[TEST_TOKEN]");
  throw new Error(`Timed out: ${label}; diagnostic: ${diagnostic}`);
}
async function health() { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).json(); }
async function start() {
  child = spawn(process.execPath, [path.join(root, "dist", "index.js")], { cwd: root, windowsHide: true, env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), ADMIN_PORT: String(adminPort), MCP_TOKEN: token, ADMIN_TOKEN: "session-test-admin", WORKSPACE_PATH: workspace, EXTRA_WORKSPACE_PATHS: "", WORKSPACE_PATHS: "", ALLOWED_WORKSPACE_PATHS: "", MCP_UPSTREAM_CONFIG: path.join(fixture, "upstream.json"), CHECKPOINT_PATH: path.join(fixture, "checkpoints"), AUDIT_LOG_PATH: path.join(fixture, "audit.log"), MCP_SHELL_STATE_DIR: path.join(fixture, "state"), MCP_SESSION_TTL_MS: "800", MCP_SESSION_CLEANUP_MS: "50", MCP_SESSION_MAX: "8", MCP_SESSION_RECOVERY_TIMEOUT_MS: "3000", SHELL_GUARD_MODE: "trusted" }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { logs += data.toString(); });
  await until(async () => { try { return (await health()).status === "ok"; } catch { return false; } }, "fixture startup", 60_000);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exit = once(child, "exit");
  child.kill();
  await exit;
}
async function post(method, params = {}, sid, options = {}) {
  const response = await fetch(endpoint, { method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...(sid ? { "mcp-session-id": sid } : {}), ...options.headers }, body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: seq++ }), method, params }), signal: AbortSignal.timeout(15_000) });
  const raw = await response.text();
  return { status: response.status, sid: response.headers.get("mcp-session-id"), body: raw.trim() ? JSON.parse(raw.startsWith("{") ? raw : raw.match(/^data:\s*(.*)$/m)[1]) : undefined };
}
async function initialize() {
  const result = await post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "session-resilience-test", version: "1" } });
  assert.equal(result.status, 200);
  assert.ok(result.sid);
  await post("notifications/initialized", {}, result.sid);
  return result.sid;
}
async function tools(sid) {
  const result = await post("tools/list", {}, sid);
  assert.equal(result.status, 200);
  assert.ok(result.body.result.tools.some(tool => tool.name === "run_command"));
  return result;
}
async function call(sid, name, args) {
  const result = await post("tools/call", { name, arguments: args }, sid);
  assert.equal(result.status, 200);
  assert.equal(result.body.result.structuredContent?.ok, true);
  return result.body.result.structuredContent.data;
}
try {
  await start();
  let sid = await initialize();
  const before = (await health()).activeSessions;
  const repeated = await post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repeat", version: "1" } }, sid);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.sid, sid);
  assert.equal((await health()).activeSessions, before);
  await tools(sid);
  assert.equal((await fetch(endpoint, { method: "DELETE", headers: { "mcp-session-id": sid } })).status, 200);
  const stale = await post("tools/list", {}, sid);
  assert.equal(stale.status, 404, "explicit termination requires fresh initialization");
  assert.equal((await health()).activeSessions, before - 1, "closed transport removed immediately");
  const reinitialized = await post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "reconnect", version: "1" } }, sid);
  assert.equal(reinitialized.status, 200);
  assert.notEqual(reinitialized.sid, sid, "a terminated transport cannot return a false successful re-init");
  await tools(reinitialized.sid);
  sid = await initialize();
  await tools(sid);
  console.log("PASS explicit DELETE removes closed transport; fresh initialization restores calls, no false successful re-init");

  const abort = new AbortController();
  const sse = await fetch(endpoint, { headers: { accept: "text/event-stream", "mcp-session-id": sid }, signal: abort.signal });
  assert.equal(sse.status, 200);
  await tools(sid);
  abort.abort();
  await tools(sid);
  console.log("PASS open SSE does not block POST; SSE disconnect preserves usable session");

  const recoveryId = randomUUID();
  const recoveryLogStart = logs.length;
  const recovered = await Promise.all(Array.from({ length: 12 }, () => tools(recoveryId)));
  assert.equal(recovered.length, 12);
  assert.equal(logs.slice(recoveryLogStart).split(`Session initialized: ${recoveryId}`).length - 1, 1);
  // A header value matching an Object.prototype property must not be confused
  // with a live session or pending recovery.
  await tools("__proto__");
  console.log("PASS concurrent stale requests share one recovery handshake; untrusted session IDs use Map storage");

  await until(async () => (await health()).activeSessions === 0, "idle cleanup");
  await tools(recoveryId);
  console.log("PASS idle cleanup closes resources; expired session reconnects before dispatch");

  sid = await initialize();
  const slow = call(sid, "run_command", { command: "python -c \"import time; time.sleep(2); print('ACTIVE_OK')\"", purpose: "Verify idle cleanup and capacity eviction leave an active harmless command running." });
  await until(async () => (await health()).sessionMetrics.activeRequests > 0, "active command begins");
  const deleting = fetch(endpoint, { method: "DELETE", headers: { "mcp-session-id": sid } });
  for (let i = 0; i < 14; i++) await initialize();
  const result = await slow;
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /ACTIVE_OK/);
  assert.equal((await deleting).status, 200);
  assert.ok((await health()).activeSessions <= 8);
  assert.equal((await post("tools/list", {}, sid)).status, 404);
  sid = await initialize();
  await tools(sid);
  console.log("PASS active command survives TTL/capacity pressure and queued DELETE; idle session count remains bounded");

  const busyIds = [];
  for (let i = 0; i < 8; i++) busyIds.push(await initialize());
  const busy = busyIds.map(id => call(id, "run_command", { command: "python -c \"import time; time.sleep(2); print('CAPACITY_OK')\"", purpose: "Check bounded overload behavior while harmless print commands are active." }));
  await until(async () => (await health()).sessionMetrics.activeRequests === 8, "all capacity slots busy");
  const overloaded = await post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "overload", version: "1" } });
  assert.equal(overloaded.status, 503);
  const completed = await Promise.all(busy);
  assert.ok(completed.every(result => result.exit_code === 0 && result.stdout.includes("CAPACITY_OK")));
  sid = await initialize();
  console.log("PASS all-busy capacity returns 503 without evicting active requests; service accepts requests after pressure subsides");

  await call(sid, "write_file", { path: "before-restart.txt", content: "before" });
  await stop();
  await start();
  await tools(sid);
  await call(sid, "write_file", { path: "after-restart.txt", content: "exactly-once" });
  assert.equal(await fs.readFile(path.join(workspace, "after-restart.txt"), "utf8"), "exactly-once");
  const audit = (await fs.readFile(path.join(fixture, "audit.log"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(audit.filter(e => e.tool === "write_file" && e.target === path.join(workspace, "after-restart.txt")).length, 1);
  const unauth = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/list" }) });
  assert.equal(unauth.status, 404, "token-free endpoint stays hidden and does not trigger OAuth discovery");
  console.log("PASS service restart recovery and file write once; authentication guard unchanged");
  process.env.MCP_SESSION_MAX = "4";
  const { createSessionManager } = await import("../dist/lib/mcp-session-manager.js");
  const deadPort = await freePort();
  const manager = createSessionManager({ workspaceRoot: workspace, workspaceRoots: [workspace], shellTimeout: 5, port: deadPort });
  for (let attempt = 0; attempt < 10; attempt++) {
    const recovered = await manager.tryRecoverStale(randomUUID(), { headers: {}, path: "/mcp/dummy-test", method: "POST" }, {}, { jsonrpc: "2.0", id: attempt, method: "tools/list" });
    assert.equal(recovered, false);
    assert.equal(manager.count(), 0);
    assert.equal(manager.stats().recovering, 0);
  }
  console.log("PASS failed recovery cleans transports and pending state; repeated failures do not exhaust capacity");
} finally {
  await stop();
  const resolved = path.resolve(fixture);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe fixture cleanup path");
  await fs.rm(resolved, { recursive: true, force: true });
}
