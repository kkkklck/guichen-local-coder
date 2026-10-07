import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const token = (process.env.MCP_TOKEN || "").trim();
if (!token) throw new Error("MCP token is unavailable");
const root = process.env.WORKSPACE_PATH || "E:\\gptonline";
const base = `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3000}/mcp/${token}`;
const folder = path.join(root, `.guichen-binary-e2e-${randomUUID()}`);
const outside = await fs.mkdtemp(path.join(os.tmpdir(), "guichen-binary-e2e-"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
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

const call = (name, args) => post("tools/call", { name, arguments: args });
function data(result, label) {
  assert.equal(result.isError, undefined, label);
  assert.equal(result.structuredContent?.ok, true, label);
  return result.structuredContent.data;
}
function rejected(result, label) {
  assert.equal(result.isError, true, label);
  console.log(`PASS ${label}`);
}

try {
  await post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "binary-upload-live-test", version: "1" } });
  const listing = await post("tools/list", {});
  const tools = new Map(listing.tools.map((tool) => [tool.name, tool]));
  for (const name of ["write_binary_file", "begin_upload", "upload_chunk", "finish_upload"]) {
    assert(tools.has(name), `${name} missing from live MCP tools/list`);
    assert(tools.get(name).inputSchema?.properties, `${name} missing inputSchema`);
  }
  for (const name of ["write_binary_file", "finish_upload"]) {
    assert.equal(tools.get(name).annotations.destructiveHint, true);
    assert.equal(tools.get(name).annotations.openWorldHint, false);
  }
  console.log("PASS live MCP discovery: four binary upload tools, schemas and annotations");

  await fs.mkdir(folder);
  const single = path.join(folder, "single.zip");
  const small = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x8a]);
  const first = data(await call("write_binary_file", { path: single, size_bytes: small.length, sha256: sha(small), content_base64: small.toString("base64") }), "single write");
  assert.equal(first.sha256, sha(small));
  assert.deepEqual(await fs.readFile(single), small);
  console.log("PASS live MCP binary create and exact SHA-256");

  const replacement = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xfe, 0x00]);
  const second = data(await call("write_binary_file", { path: single, size_bytes: replacement.length, sha256: sha(replacement), content_base64: replacement.toString("base64") }), "overwrite");
  assert.deepEqual(await fs.readFile(single), replacement);
  assert(second.checkpoint_id);
  console.log("PASS live MCP overwrite with checkpoint");

  const large = randomBytes(2_300_333);
  const largePath = path.join(folder, "multi.bin");
  const upload = data(await call("begin_upload", { path: largePath, size_bytes: large.length, sha256: sha(large) }), "begin upload");
  assert.match(upload.session_id, /^[0-9a-f-]{36}$/);
  const parts = [large.subarray(0, 750_000), large.subarray(750_000, 1_500_000), large.subarray(1_500_000)];
  for (let index = 0; index < parts.length; index++) {
    const chunk = data(await call("upload_chunk", { session_id: upload.session_id, index, content_base64: parts[index].toString("base64") }), `chunk ${index}`);
    assert.equal(chunk.next_index, index + 1);
  }
  const finished = data(await call("finish_upload", { session_id: upload.session_id }), "finish upload");
  assert.equal(finished.sha256, sha(large));
  assert.deepEqual(await fs.readFile(largePath), large);
  console.log("PASS live MCP multi-chunk transfer, size and final SHA-256");

  const badHash = data(await call("begin_upload", { path: single, size_bytes: small.length, sha256: "0".repeat(64) }), "begin bad hash");
  data(await call("upload_chunk", { session_id: badHash.session_id, index: 0, content_base64: small.toString("base64") }), "bad hash chunk");
  rejected(await call("finish_upload", { session_id: badHash.session_id }), "live MCP SHA-256 mismatch rejected");
  assert.deepEqual(await fs.readFile(single), replacement);

  const outOfOrder = data(await call("begin_upload", { path: path.join(folder, "out-of-order.bin"), size_bytes: small.length, sha256: sha(small) }), "begin out-of-order");
  rejected(await call("upload_chunk", { session_id: outOfOrder.session_id, index: 1, content_base64: small.toString("base64") }), "live MCP out-of-order chunk rejected");
  rejected(await call("finish_upload", { session_id: outOfOrder.session_id }), "cancelled session cannot finish");

  const victim = path.join(outside, "victim.bin");
  await fs.writeFile(victim, small);
  rejected(await call("write_binary_file", { path: victim, size_bytes: small.length, sha256: sha(small), content_base64: small.toString("base64") }), "live MCP outside workspace rejected");
  const junction = path.join(folder, "outside-junction");
  await fs.symlink(outside, junction, process.platform === "win32" ? "junction" : "dir");
  rejected(await call("begin_upload", { path: path.join(junction, "escaped.bin"), size_bytes: 0, sha256: sha(Buffer.alloc(0)) }), "live MCP Junction escape rejected");
  assert.deepEqual(await fs.readFile(victim), small);
  assert.equal(await fs.stat(path.join(outside, "escaped.bin")).catch(() => null), null);
  await fs.unlink(junction);

  const staged = await fs.readdir(path.join(root, ".guichen-upload-staging"));
  assert(!staged.some((name) => name.endsWith(".part")), "upload staging contains an incomplete transfer");
  console.log("PASS failed live transfers leave no staged files");
} finally {
  const junction = path.join(folder, "outside-junction");
  const linkStat = await fs.lstat(junction).catch(() => null);
  if (linkStat?.isSymbolicLink()) await fs.unlink(junction);
  if (!path.resolve(folder).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)) throw new Error("Unsafe workspace cleanup path");
  await fs.rm(folder, { recursive: true, force: true });
  if (!path.resolve(outside).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe temporary cleanup path");
  await fs.rm(outside, { recursive: true, force: true });
}
