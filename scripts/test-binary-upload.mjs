import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { setDefaultCwd } from "../dist/lib/path-security.js";
import { BinaryUploadManager, MAX_BINARY_CHUNK_BYTES } from "../dist/lib/binary-upload.js";
import { logMcpRequest, getRecentActivity } from "../dist/lib/activity-log.js";

const parent = await fs.mkdtemp(path.join(os.tmpdir(), "guichen-binary-test-"));
const workspace = path.join(parent, "workspace");
const outside = path.join(parent, "outside");
await fs.mkdir(workspace);
await fs.mkdir(outside);
const originalCwd = process.cwd();
const originalCheckpointPath = process.env.CHECKPOINT_PATH;
setDefaultCwd(workspace);
process.env.CHECKPOINT_PATH = path.join(parent, "checkpoints");
const manager = new BinaryUploadManager(150);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const staged = async () => (await fs.readdir(path.join(workspace, ".guichen-upload-staging"))).filter((name) => name.endsWith(".part"));
try {
  const small = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0xff, 0x89, 0x50, 0x4e, 0x47]);
  const singlePath = path.join(workspace, "arbitrary.zip");
  const one = await manager.writeSingle(singlePath, small.length, sha(small), small.toString("base64"));
  assert.equal(one.sha256, sha(small));
  assert.deepEqual(await fs.readFile(singlePath), small);
  assert.deepEqual(await staged(), []);
  console.log("PASS single-call byte-exact binary write");

  await assert.rejects(manager.writeSingle(path.join(workspace, "invalid.bin"), small.length, sha(small), "@@not-base64@@"), /canonical Base64/);
  await assert.rejects(fs.stat(path.join(workspace, "invalid.bin")), { code: "ENOENT" });
  const empty = Buffer.alloc(0);
  await manager.writeSingle(path.join(workspace, "empty.bin"), 0, sha(empty), "");
  assert.deepEqual(await fs.readFile(path.join(workspace, "empty.bin")), empty);
  console.log("PASS invalid Base64 rejected and empty files supported");

  const replacement = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xfe]);
  const overwritten = await manager.writeSingle(singlePath, replacement.length, sha(replacement), replacement.toString("base64"));
  assert.deepEqual(await fs.readFile(singlePath), replacement);
  assert.equal(overwritten.sha256, sha(replacement));
  assert(overwritten.checkpoint_id, "overwrite should create a checkpoint");
  console.log("PASS existing binary file is replaced with checkpoint");

  const large = randomBytes(MAX_BINARY_CHUNK_BYTES + 713_123);
  const largePath = path.join(workspace, "large.pdf");
  const started = await manager.begin(largePath, large.length, sha(large));
  const parts = [large.subarray(0, 1_000_000), large.subarray(1_000_000, 2_000_000), large.subarray(2_000_000)];
  for (let index = 0; index < parts.length; index++) {
    const result = await manager.append(started.session_id, index, parts[index].toString("base64"));
    assert.equal(result.next_index, index + 1);
  }
  const completed = await manager.finish(started.session_id);
  assert.equal(completed.size_bytes, large.length);
  assert.equal(completed.sha256, sha(large));
  assert.deepEqual(await fs.readFile(largePath), large);
  assert.deepEqual(await staged(), []);
  console.log("PASS multi-chunk order, size, SHA-256 and final bytes");

  const protectedPath = path.join(workspace, "protected.bin");
  await fs.writeFile(protectedPath, "original");
  const badHash = await manager.begin(protectedPath, small.length, "0".repeat(64));
  await manager.append(badHash.session_id, 0, small.toString("base64"));
  await assert.rejects(manager.finish(badHash.session_id), /SHA-256 mismatch/);
  assert.equal(await fs.readFile(protectedPath, "utf8"), "original");
  assert.deepEqual(await staged(), []);
  console.log("PASS hash mismatch preserves existing destination and cleans temporary file");

  const outOfOrderPath = path.join(workspace, "out-of-order.bin");
  const ordered = await manager.begin(outOfOrderPath, small.length, sha(small));
  await assert.rejects(manager.append(ordered.session_id, 1, small.toString("base64")), /out of order/);
  await assert.rejects(fs.stat(outOfOrderPath), { code: "ENOENT" });
  assert.deepEqual(await staged(), []);
  const incomplete = await manager.begin(path.join(workspace, "incomplete.bin"), small.length + 1, sha(small));
  await manager.append(incomplete.session_id, 0, small.toString("base64"));
  await assert.rejects(manager.finish(incomplete.session_id), /incomplete/);
  assert.deepEqual(await staged(), []);
  console.log("PASS out-of-order and incomplete transfers are discarded");

  const timedPath = path.join(workspace, "timed-out.bin");
  const timed = await manager.begin(timedPath, small.length, sha(small));
  await manager.append(timed.session_id, 0, small.toString("base64"));
  await new Promise((resolve) => setTimeout(resolve, 220));
  await manager.cleanupExpired();
  await assert.rejects(manager.finish(timed.session_id), /Unknown upload session|timed out/);
  await assert.rejects(fs.stat(timedPath), { code: "ENOENT" });
  assert.deepEqual(await staged(), []);
  console.log("PASS interrupted transfer times out and cleans temporary file");

  await assert.rejects(manager.begin(path.join(outside, "escape.bin"), 0, sha(Buffer.alloc(0))), /SECURITY/);
  await assert.rejects(manager.begin(path.join(workspace, "..", "outside", "escape.bin"), 0, sha(Buffer.alloc(0))), /SECURITY/);
  const junction = path.join(workspace, "linked-outside");
  await fs.symlink(outside, junction, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(manager.begin(path.join(junction, "escape.bin"), 0, sha(Buffer.alloc(0))), /SECURITY/);
  assert.deepEqual(await staged(), []);
  console.log("PASS absolute, traversal and Junction escapes rejected");

  const linkedRoot = path.join(parent, "linked-workspace");
  await fs.symlink(workspace, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  setDefaultCwd(linkedRoot);
  await assert.rejects(new BinaryUploadManager().begin(path.join(linkedRoot, "escape.bin"), 0, sha(Buffer.alloc(0))), /SECURITY/);
  setDefaultCwd(workspace);
  await fs.unlink(linkedRoot);
  console.log("PASS workspace root Junction rejected");

  const marker = "U2Vuc2l0aXZlQmluYXJ5TWFya2Vy";
  logMcpRequest({ method: "tools/call", params: { name: "upload_chunk", arguments: { session_id: "safe", index: 0, content_base64: marker } } }, "test", 1, 200);
  assert(!JSON.stringify(getRecentActivity(1)).includes(marker));
  console.log("PASS Base64 payload redacted from MCP activity log");
} finally {
  setDefaultCwd(originalCwd);
  if (originalCheckpointPath === undefined) delete process.env.CHECKPOINT_PATH;
  else process.env.CHECKPOINT_PATH = originalCheckpointPath;
  const resolved = path.resolve(parent);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe cleanup path");
  await fs.rm(parent, { recursive: true, force: true });
}
