import assert from "node:assert/strict";
import "dotenv/config";

const expected = process.argv[2];
if (expected !== "allow" && expected !== "deny") throw new Error("Usage: node scripts/test-shell-approval-e2e.mjs allow|deny");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const token = (process.env.MCP_TOKEN || "").trim();
if (!token) throw new Error("MCP token is unavailable; refusing to test an unauthenticated server.");
const endpoint = `http://${host}:${port}/mcp/${token}`;
let sessionId;

async function post(body, session) {
  const response = await fetch(endpoint, {
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
  if (response.status === 202 && !raw.trim()) return { response, payload: null };
  try { return { response, payload: JSON.parse(raw) }; }
  catch {
    const data = raw.match(/^data:\s*(.+)$/m)?.[1];
    if (data) return { response, payload: JSON.parse(data) };
    throw new Error(`MCP returned non-JSON HTTP ${response.status}`);
  }
}

const init = await post({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "shell-approval-e2e", version: "1.0" },
  },
});
assert.ok(init.response.ok, `MCP initialize failed with HTTP ${init.response.status}`);
sessionId = init.response.headers.get("mcp-session-id");
assert.ok(sessionId, "MCP session id was not returned");
await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);

const response = await post({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: {
    name: "run_command",
    arguments: {
      command: "python -c \"print('APPROVAL_OK')\"",
      purpose: "打印固定标记，验证本次 Shell 审批结果。",
    },
  },
}, sessionId);
assert.ok(response.response.ok, `run_command failed with HTTP ${response.response.status}`);
const structured = response.payload?.result?.structuredContent;
assert.ok(structured, "run_command did not return structuredContent");
const data = structured.data;

if (expected === "allow") {
  assert.equal(structured.ok, true, JSON.stringify(structured));
  assert.equal(data?.approved, true, JSON.stringify(data));
  assert.equal(data?.exit_code, 0, JSON.stringify(data));
  assert.match(data?.stdout ?? "", /APPROVAL_OK/);
  console.log(JSON.stringify({ result: "PASS", approved: data.approved, decision: "approved", exit_code: data.exit_code, stdout: data.stdout.trim(), request_id: data.request_id }));
} else {
  assert.equal(structured.ok, false, JSON.stringify(structured));
  assert.equal(data?.approved, false, JSON.stringify(data));
  assert.equal(data?.decision, "denied", JSON.stringify(data));
  assert.equal(data?.reason, "You denied this one-time shell request.");
  assert.ok(!JSON.stringify(data).includes("APPROVAL_OK"), "denied command output must not contain the marker");
  console.log(JSON.stringify({ result: "PASS", decision: data.decision, executed: false, request_id: data.request_id }));
}
