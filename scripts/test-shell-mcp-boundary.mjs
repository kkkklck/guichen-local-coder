import "dotenv/config";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const token = (process.env.MCP_TOKEN || "").trim();
const workspace = process.env.WORKSPACE_PATH || "E:\\gptonline";
if (!token) throw new Error("MCP token is unavailable; refusing to test an unauthenticated server.");
const base = "http://" + host + ":" + port;
let sessionId;

async function post(body, session) {
  const response = await fetch(base + "/mcp/" + token, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (response.status === 202 && !raw.trim()) {
    return { response, payload: null };
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    const data = raw.match(/^data:\s*(.+)$/m)?.[1];
    if (!data) throw new Error("MCP returned non-JSON HTTP " + response.status);
    payload = JSON.parse(data);
  }
  return { response, payload };
}

function pass(label) { console.log("PASS " + label); }

const health = await fetch(base + "/health");
if (!health.ok) throw new Error("Local Coder health endpoint failed.");
const healthData = await health.json();
if (healthData.workspace?.toLowerCase() !== workspace.toLowerCase() ||
    healthData.fullMachineAccess !== false || healthData.fullDiskAccess !== false) {
  throw new Error("Workspace access boundary health check failed.");
}
pass("health retains workspace-only file boundary");

const init = await post({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "shell-boundary-test", version: "1.0" },
  },
});
if (!init.response.ok) throw new Error("initialize failed: HTTP " + init.response.status);
sessionId = init.response.headers.get("mcp-session-id");
if (!sessionId) throw new Error("MCP session id was not returned.");
await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);

const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
const listedTools = listed.payload.result.tools;
const tools = new Set(listedTools.map((item) => item.name));
console.log("MCP tools/list names: " + [...tools].join(", "));
for (const item of listedTools.filter((tool) => ["run_command", "start_process", "process_output", "process_status", "stop_process", "shell_status", "shell_reset"].includes(tool.name))) {
  console.log("MCP shell tool schema: " + JSON.stringify({ name: item.name, description: item.description, inputSchema: item.inputSchema }));
}
for (const name of ["run_command", "start_process", "process_output", "process_status", "stop_process"]) {
  if (!tools.has(name)) throw new Error("Expected approval-gated shell tool " + name + " was not exposed.");
}
for (const name of ["node_repl", "git_status", "git_commit", "git_push", "mcp_call"]) {
  if (tools.has(name)) throw new Error("Hard-disabled tool unexpectedly exposed: " + name);
}
pass("approval-gated shell tools exposed; Git and Node REPL remain disabled");

async function call(name, args, id) {
  const result = await post({
    jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
  }, sessionId);
  if (!result.response.ok) throw new Error(name + " failed: HTTP " + result.response.status);
  return result.payload.result;
}

const version = await call("run_command", {
  command: "python --version",
  purpose: "Read the installed Python version for a local environment check.",
}, 3);
if (version?.structuredContent?.ok !== true) throw new Error("Fixed read-only shell diagnostic did not run.");
console.log("python --version result: " + JSON.stringify(version.structuredContent));
pass("fixed read-only diagnostic ran without an approval prompt");

const escape = await call("run_command", {
  command: "Get-Content C:\\Windows\\win.ini",
  purpose: "Attempt a deliberately out-of-workspace read to verify the hard block.",
}, 4);
if (escape?.structuredContent?.data?.approved !== false) throw new Error("Out-of-workspace shell path was not hard-blocked.");
console.log("blocked request result: " + JSON.stringify(escape.structuredContent));
pass("out-of-workspace shell path blocked before execution");

const fileEscape = await call("read_text_file", { path: "C:\\Windows\\win.ini" }, 5);
if (!fileEscape?.isError) throw new Error("File tool no longer blocks an outside-workspace read.");
pass("existing file-tool workspace guard still blocks C:\\ reads");

console.log("ALL SHELL BOUNDARY CHECKS PASSED");
