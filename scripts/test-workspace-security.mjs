import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setDefaultCwd, validatePath, assertWorkspaceBoundary, assertNotWorkspaceRoot, assertNoReparseTree } from "../dist/lib/path-security.js";
import { applyMultiFilePatch } from "../dist/lib/patch.js";
import { toolAnnotations } from "../dist/lib/tool-annotations.js";

const parent = await fs.mkdtemp(path.join(os.tmpdir(), "guichen-workspace-security-"));
const workspace = path.join(parent, "workspace");
const outside = path.join(parent, "outside");
await fs.mkdir(workspace);
await fs.mkdir(outside);
const originalCwd = process.cwd();
try {
  setDefaultCwd(workspace);
  await assertWorkspaceBoundary();
  const file = await validatePath("ordinary.txt");
  await fs.writeFile(file, "created");
  assert.equal(await fs.readFile(file, "utf8"), "created");
  await fs.writeFile(await validatePath("ordinary.txt"), "overwritten");
  assert.equal(await fs.readFile(file, "utf8"), "overwritten");
  await fs.unlink(await validatePath("ordinary.txt"));
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  console.log("PASS workspace create, overwrite and delete");

  await assert.rejects(validatePath(path.join(outside, "victim.txt")), /SECURITY/);
  await assert.rejects(validatePath(path.join(workspace, "..", "outside", "victim.txt")), /SECURITY/);
  assert.throws(() => assertNotWorkspaceRoot(workspace), /SECURITY/);
  const victim = path.join(outside, "victim.txt");
  await fs.writeFile(victim, "keep");
  const patch = `*** Begin Patch\n*** Delete File: ../outside/victim.txt\n*** End Patch`;
  const patchResults = await applyMultiFilePatch(patch, { base_dir: workspace });
  assert.equal(patchResults[0].ok, false);
  assert.equal(await fs.readFile(victim, "utf8"), "keep");
  console.log("PASS cross-directory path and patch delete/write blocked");

  const junction = path.join(workspace, "outside-link");
  await fs.symlink(outside, junction, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(validatePath(path.join(junction, "victim.txt")), /SECURITY/);
  await assert.rejects(assertNoReparseTree(workspace), /SECURITY/);
  console.log("PASS junction escape and recursive delete guard");

  const linkedRoot = path.join(parent, "linked-root");
  await fs.symlink(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  setDefaultCwd(linkedRoot);
  await assert.rejects(assertWorkspaceBoundary(), /SECURITY/);
  await assert.rejects(validatePath(path.join(linkedRoot, "victim.txt")), /SECURITY/);
  console.log("PASS workspace root junction rejected");

  for (const risk of ["command", "edit", "destructive"]) {
    const annotation = toolAnnotations(risk);
    assert.equal(annotation.readOnlyHint, false);
    assert.equal(annotation.destructiveHint, true);
  }
  assert.equal(toolAnnotations("command").openWorldHint, true);
  assert.equal(toolAnnotations("read").readOnlyHint, true);
  console.log("PASS honest MCP tool annotations");
} finally {
  setDefaultCwd(originalCwd);
  const resolved = path.resolve(parent);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe test cleanup path");
  await fs.rm(parent, { recursive: true, force: true });
}
