import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const token = (process.env.MCP_TOKEN || "").trim();
if (!token) throw new Error("MCP token is unavailable");
const root = process.env.WORKSPACE_PATH || "E:\\gptonline";
const base = `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3000}/mcp/${token}`;
const folder = path.join(root, `.guichen-file-e2e-${randomUUID()}`);
const outside = await fs.mkdtemp(path.join(os.tmpdir(), "guichen-file-e2e-"));
const victim = path.join(outside, "victim.txt");
let session;
let requestId = 1;
async function post(method, params) {
  const response = await fetch(base, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method, ...(params ? { params } : {}) }),
  });
  if (!session) session = response.headers.get("mcp-session-id");
  const raw = await response.text();
  const json = raw.startsWith("data:") ? JSON.parse(raw.match(/^data:\s*(.*)$/m)[1]) : JSON.parse(raw);
  if (!response.ok || json.error) throw new Error(`${method} returned an MCP error`);
  return json.result;
}
async function call(name, args) { return post("tools/call", { name, arguments: args }); }
function success(result, label) {
  assert.equal(result.isError, undefined, label);
  assert.equal(result.structuredContent?.ok, true, label);
  console.log(`PASS ${label}`);
}
try {
  await fs.writeFile(victim, "keep");
  await post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "file-workflow-test", version: "1" } });
  const listing = await post("tools/list", {});
  const names = new Map(listing.tools.map((tool) => [tool.name, tool]));
  for (const name of ["delete_file", "create_directory", "delete_directory", "copy_file", "move_file", "extract_pdf_text", "convert_document_text"]) assert(names.has(name), `${name} missing`);
  assert.equal(names.get("run_command").annotations.destructiveHint, true);
  assert.equal(names.get("run_command").annotations.openWorldHint, true);
  assert.equal(names.get("delete_directory").annotations.destructiveHint, true);
  console.log("PASS MCP tools/list exposes bounded file and document tools with honest Shell hints");

  const samplePdf = path.join(root, "nature-skills", "skills", "nature-figure", "assets", "figures4papers", "figure_Cflows", "figures", "figX_comparison_Ablation.pdf");
  if (await fs.stat(samplePdf).catch(() => null)) {
    const extracted = await call("extract_pdf_text", { path: samplePdf, max_chars: 500 });
    success(extracted, "live MCP PDF text extraction");
    assert(extracted.structuredContent.data.text.length > 0);
  }

  success(await call("create_directory", { path: folder }), "workspace directory create");
  const file = path.join(folder, "ordinary.txt");
  success(await call("write_file", { path: file, content: "created" }), "workspace file create");
  success(await call("write_file", { path: file, content: "overwritten" }), "workspace file overwrite");
  assert.equal(await fs.readFile(file, "utf8"), "overwritten");
  success(await call("delete_file", { path: file }), "workspace file delete");
  await assert.rejects(fs.stat(file), { code: "ENOENT" });

  const blocked = await call("delete_file", { path: victim });
  assert.equal(blocked.isError, true);
  assert.equal(await fs.readFile(victim, "utf8"), "keep");
  console.log("PASS cross-directory delete rejected");

  const junction = path.join(folder, "outside-junction");
  await fs.symlink(outside, junction, process.platform === "win32" ? "junction" : "dir");
  const linkedDelete = await call("delete_file", { path: path.join(junction, "victim.txt") });
  assert.equal(linkedDelete.isError, true);
  assert.equal(await fs.readFile(victim, "utf8"), "keep");
  const linkedTree = await call("delete_directory", { path: folder });
  assert.equal(linkedTree.isError, true);
  console.log("PASS junction escape and recursive delete rejected");
  const stat = await fs.lstat(junction);
  assert(stat.isSymbolicLink());
  await fs.unlink(junction);
  success(await call("delete_directory", { path: folder }), "workspace directory delete");
} finally {
  const resolvedFolder = path.resolve(folder);
  if (!resolvedFolder.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)) throw new Error("Unsafe workspace cleanup path");
  const remaining = await fs.lstat(folder).catch(() => null);
  if (remaining) {
    const junction = path.join(folder, "outside-junction");
    const linkStat = await fs.lstat(junction).catch(() => null);
    if (linkStat?.isSymbolicLink()) await fs.unlink(junction);
    await fs.rm(folder, { recursive: true, force: true });
  }
  const resolvedOutside = path.resolve(outside);
  if (!resolvedOutside.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe temporary cleanup path");
  await fs.rm(outside, { recursive: true, force: true });
}
