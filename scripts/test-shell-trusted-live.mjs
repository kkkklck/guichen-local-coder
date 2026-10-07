import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const token = process.env.MCP_TOKEN?.trim();
if (!token) throw new Error("MCP token unavailable");
const base = `http://${process.env.HOST || "127.0.0.1"}:${Number(process.env.PORT || 3000)}`;
const endpoint = `${base}/mcp/${token}`;
const workspace = process.env.WORKSPACE_PATH;
const marker = `.trusted-blocked-${randomUUID()}.txt`;
let session;
let sequence = 1;
async function post(method, params, notification = false) {
  const response = await fetch(endpoint, { method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: sequence++ }), method, ...(params ? { params } : {}) }) });
  assert.ok(response.ok, `MCP HTTP ${response.status}`);
  if (method === "initialize") session = response.headers.get("mcp-session-id");
  const raw = await response.text();
  if (!raw.trim()) return;
  const json = JSON.parse(raw.startsWith("{") ? raw : raw.match(/^data:\s*(.+)$/m)[1]);
  assert.ok(!json.error, "MCP protocol error");
  return json.result;
}
async function call(name, args) { return post("tools/call", { name, arguments: args }); }
try {
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.shellGuardMode, "trusted");
  assert.equal(health.fileToolAccess, "workspace_only");
  assert.equal(health.shellSandboxed, false);
  const init = await post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "trusted-shell-live-test", version: "1.0" } });
  assert.ok(session);
  assert.match(init.instructions, /trusted mode/);
  await post("notifications/initialized", undefined, true);
  const listed = await post("tools/list", {});
  const tools = listed.tools;
  assert.equal(tools.find(t => t.name === "run_command").annotations.readOnlyHint, false);
  assert.equal(tools.find(t => t.name === "run_command").annotations.openWorldHint, true);
  assert.match(tools.find(t => t.name === "start_process").description, /trusted mode/);
  assert.ok(!tools.some(t => ["node_repl", "git_commit", "mcp_call"].includes(t.name)));
  const purpose = "Verify the explicitly authorized trusted mode using a harmless print command.";
  const results = await Promise.all(["TRUSTED_OK_A", "TRUSTED_OK_B"].map(value => call("run_command", { command: `python -c "print('${value}')"`, purpose })));
  for (let i = 0; i < results.length; i++) {
    const result = results[i].structuredContent;
    assert.equal(result.ok, true);
    assert.equal(result.data.approved, true);
    assert.equal(result.data.authorization, "trusted");
    assert.equal(result.data.guard_mode, "trusted");
    assert.equal(result.data.exit_code, 0);
    assert.match(result.data.stdout, new RegExp(`TRUSTED_OK_${i === 0 ? "A" : "B"}`));
  }
  assert.notEqual(results[0].structuredContent.data.request_id, results[1].structuredContent.data.request_id);
  // The flagged text is a string literal. Even a broken guard would only create
  // a disposable marker; this test never invokes an actual destructive command.
  const blocked = await call("run_command", { command: `python -c "from pathlib import Path; Path('${marker}').write_text('Format-Volume')"`, purpose: "Verify a harmless marker containing blocked text is rejected before execution." });
  assert.equal(blocked.structuredContent.data.approved, false);
  assert.equal(blocked.structuredContent.data.decision, "blocked");
  await assert.rejects(fs.stat(path.join(workspace, marker)), { code: "ENOENT" });
  const outside = await call("read_text_file", { path: "C:\\Windows\\win.ini" });
  assert.equal(outside.isError, true);
  const started = await call("start_process", { command: "python -c \"print('TRUSTED_BACKGROUND_OK')\"", purpose });
  assert.equal(started.structuredContent.data.authorization, "trusted");
  const id = started.structuredContent.data.id;
  let status;
  for (let attempt = 0; attempt < 40; attempt++) {
    status = (await call("process_status", { id })).structuredContent.data;
    if (status.processes[0]?.exit_code !== null) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const output = (await call("process_output", { id })).structuredContent.data;
  assert.match(output.stdout, /TRUSTED_BACKGROUND_OK/);
  assert.equal(output.exit_code, 0);
  console.log("PASS real MCP trusted Python calls: approved=true, authorization=trusted, stdout matched, exit_code=0, unique request IDs");
  console.log("PASS blocked marker did not execute; dedicated file tool still rejects outside-workspace paths");
  console.log("PASS trusted background process, honest tool schema, disabled execution tools remain absent");
} finally {
  if (session) await fetch(endpoint, { method: "DELETE", headers: { "mcp-session-id": session } }).catch(() => {});
  if (workspace) await fs.unlink(path.join(workspace, marker)).catch(() => {});
}
