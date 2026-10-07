import "dotenv/config";
import { randomUUID } from "node:crypto";
import { shouldExposeTool } from "../dist/lib/tool-profile.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const token = (process.env.MCP_TOKEN || "").trim();
const workspace = process.env.WORKSPACE_PATH || "E:\\gptonline";
const testFile = `${workspace}\\.guichen-phase1-${randomUUID()}.txt`;
const base = `http://${host}:${port}`;

if (!token) throw new Error("MCP_TOKEN is missing; refusing to test an unauthenticated server");

function pass(name) {
  console.log(`PASS ${name}`);
}

function fail(name, detail) {
  console.error(`FAIL ${name}: ${detail}`);
  process.exitCode = 1;
}

async function post(body, sessionId, omitContentType = false) {
  const headers = {
    // Match tunnel-client's narrower legacy probe header.
    accept: "application/json",
    "mcp-protocol-version": "2025-06-18",
  };
  if (!omitContentType) headers["content-type"] = "application/json";
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(`${base}/mcp/${token}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let json;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    const data = raw.match(/^data:\s*(.+)$/m)?.[1];
    if (data) json = JSON.parse(data);
    else throw new Error(`MCP returned non-JSON HTTP ${response.status}`);
  }
  return { response, json };
}

try {
  const healthResponse = await fetch(`${base}/health`);
  if (!healthResponse.ok) throw new Error(`/health returned HTTP ${healthResponse.status}`);
  const health = await healthResponse.json();
  if (
    health.status !== "ok" ||
    health.workspace.toLowerCase() !== workspace.toLowerCase() ||
    health.defaultCwd.toLowerCase() !== workspace.toLowerCase() ||
    health.fullMachineAccess !== false ||
    health.fullDiskAccess !== false
  ) {
    throw new Error("/health did not report the required workspace and access boundaries");
  }
  if (JSON.stringify(health).includes(token)) throw new Error("/health exposed MCP_TOKEN");
  pass("health retains dedicated file-tool workspace boundary and declares Shell policy; token hidden");

  const initRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "phase1-security-test", version: "1.0.0" },
    },
  };
  const init = await post(initRequest, undefined, true);
  if (!init.response.ok || !init.json?.result?.protocolVersion) {
    throw new Error(`initialize failed with HTTP ${init.response.status}`);
  }
  const instructions = init.json.result.instructions || "";
  const normalizedInstructions = instructions.toLowerCase();
  if (
    !normalizedInstructions.includes("dedicated file tools: workspace-only") ||
    !normalizedInstructions.includes(health.shellGuardMode === "trusted" ? "trusted mode" : "approval mode") ||
    !normalizedInstructions.includes("not an os sandbox") ||
    !normalizedInstructions.includes("git tools, node repl, and upstream mcp delegation remain disabled")
  ) {
    throw new Error("MCP instructions do not accurately describe the workspace and shell approval boundaries");
  }
  if (instructions.includes(token)) throw new Error("MCP initialize instructions exposed MCP_TOKEN");
  const sessionId = init.response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("initialize did not return mcp-session-id");

  const initialized = await post(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
  );
  if (![200, 202, 204].includes(initialized.response.status)) {
    throw new Error(`notifications/initialized failed with HTTP ${initialized.response.status}`);
  }

  const repeatedInit = await post(initRequest, sessionId, true);
  if (!repeatedInit.response.ok || !repeatedInit.json?.result?.serverInfo) {
    throw new Error("repeated initialize was not handled idempotently");
  }

  const list = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId,
  );
  if (!list.response.ok || !Array.isArray(list.json?.result?.tools)) {
    throw new Error(`tools/list failed with HTTP ${list.response.status}`);
  }
  const names = new Set(list.json.result.tools.map((tool) => tool.name));
  const forbidden = [
    "node_repl",
    "git_status",
    "git_commit",
    "git_push",
    "mcp_call",
    "mcp_tools",
    "ponytail_turn",
    "agent_status",
    "project_context",
    "load_path_rules",
    "list_skills",
    "load_skill",
  ];
  const enabledInFullProfile = forbidden.filter((name) => shouldExposeTool(name, "full"));
  if (enabledInFullProfile.length) {
    throw new Error(`Phase 1 denylist bypassed by full profile: ${enabledInFullProfile.join(", ")}`);
  }
  const exposed = forbidden.filter((name) => names.has(name));
  if (exposed.length) throw new Error(`forbidden tools exposed: ${exposed.join(", ")}`);
  const shellTools = ["run_command", "shell_status", "shell_reset", "start_process", "process_status", "process_output", "stop_process"];
  const missingShellTools = shellTools.filter((name) => !names.has(name) || !shouldExposeTool(name, "full"));
  if (missingShellTools.length) throw new Error(`Shell Guard tools missing: ${missingShellTools.join(", ")}`);
  pass("Shell Guard tools exposed; Git, REPL, and MCP delegation remain disabled");

  async function call(name, args, id) {
    const result = await post(
      { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
      sessionId,
    );
    if (!result.response.ok) throw new Error(`${name} returned HTTP ${result.response.status}`);
    return result.json?.result;
  }

  const created = await call("write_file", { path: testFile, content: "hello from gptonline" }, 3);
  if (created?.isError) throw new Error("could not create workspace test fixture");
  const read = await call("read_text_file", { path: testFile }, 4);
  if (read?.isError || !JSON.stringify(read).includes("hello from gptonline")) {
    throw new Error("workspace read did not return the expected test file content");
  }
  pass("workspace read");

  const blockedRead = await call("read_text_file", { path: "C:\\Windows\\win.ini" }, 5);
  if (!blockedRead?.isError) throw new Error("C:\\ read was not blocked");
  pass("C:\\ read blocked");

  const write = await call(
    "write_file",
    { path: testFile, content: "phase1 MCP write test" },
    6,
  );
  if (write?.isError) throw new Error("workspace write returned an MCP error");
  pass("workspace write");

  const blockedWrite = await call(
    "write_file",
    { path: "E:\\GPTLocalBridge\\escape-test.txt", content: "must never be written" },
    7,
  );
  if (!blockedWrite?.isError) throw new Error("bridge directory write was not blocked");
  pass("bridge write blocked");

  const removed = await call("delete_file", { path: testFile }, 8);
  if (removed?.isError) throw new Error("workspace test fixture cleanup failed");

  if (!process.exitCode) console.log("ALL SECURITY CHECKS PASSED");
} catch (error) {
  fail("phase 1 MCP security checks", error instanceof Error ? error.message : "unknown error");
}
