import fs from "fs";
import fsp from "fs/promises";
import path from "path";

let defaultCwd = process.cwd();
let allowedRoot = process.cwd();

function normalizeCompare(p: string): string {
  let resolved = path.resolve(p);

  if (process.platform === "win32") {
    resolved = resolved.toLowerCase();
  }

  const parsed = path.parse(resolved);
  if (resolved !== parsed.root) {
    resolved = resolved.replace(/[\\\/]+$/, "");
  }

  return resolved;
}

function isInside(root: string, candidate: string): boolean {
  const r = normalizeCompare(root);
  const c = normalizeCompare(candidate);

  if (r === c) return true;

  const rel = path.relative(r, c);

  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

async function checkedRoot(): Promise<string> {
  const root = path.resolve(allowedRoot);
  const stat = await fsp.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`SECURITY: workspace root is not an ordinary directory: ${root}`);
  }
  const real = await fsp.realpath(root);
  if (normalizeCompare(root) !== normalizeCompare(real)) {
    throw new Error(`SECURITY: workspace root resolves through a reparse point: ${root}`);
  }
  return real;
}

/**
 * 对不存在的新文件，找到最近的已存在父目录并 realpath。
 * 这样可以识别：
 *
 * E:\gptonline\junction-to-C\newfile.txt
 *
 * 即使 newfile.txt 尚不存在，也不能通过 junction/symlink 越界。
 */
async function canonicalForBoundary(target: string): Promise<string> {
  const absolute = path.resolve(target);

  let probe = absolute;

  while (true) {
    try {
      await fsp.lstat(probe);

      const realExisting = await fsp.realpath(probe);
      const remainder = path.relative(probe, absolute);

      return remainder
        ? path.resolve(realExisting, remainder)
        : realExisting;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;

      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw err;
      }

      const parent = path.dirname(probe);

      if (parent === probe) {
        return absolute;
      }

      probe = parent;
    }
  }
}

function containsGitControlPath(candidate: string): boolean {
  const rel = path.relative(path.resolve(allowedRoot), path.resolve(candidate));

  if (!rel) return false;

  return rel
    .split(/[\\/]+/)
    .some((part) => part.toLowerCase() === ".git");
}

export function setDefaultCwd(cwd: string): void {
  const resolved = path.resolve(cwd);
  defaultCwd = resolved;
  allowedRoot = resolved;
}

export function getDefaultCwd(): string {
  return defaultCwd;
}

/** compatibility */
export function setAllowedRoots(roots: string[]): void {
  if (roots.length > 0) {
    setDefaultCwd(roots[0]);
  }
}

/**
 * 这里只返回真正的安全边界。
 * 不再把整台机器的盘符告诉 Agent。
 */
export function getAllowedRoots(): string[] {
  return [allowedRoot];
}

export function setFullDiskAccess(_enabled: boolean): void {
  // Intentionally ignored.
  // Full disk access is permanently disabled in this hardened build.
}

export function getFullDiskAccess(): boolean {
  return false;
}

export async function validatePath(inputPath: string): Promise<string> {
  const trimmed = inputPath.trim();

  if (!trimmed) {
    throw new Error("Path is empty");
  }

  if (process.platform === "win32" && trimmed.slice(2).includes(":")) {
    throw new Error("SECURITY: alternate data streams are not allowed");
  }

  const requested = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(defaultCwd, trimmed);

  const rootCanonical = await checkedRoot();
  if (!isInside(allowedRoot, requested)) {
    throw new Error(`SECURITY: path outside allowed workspace. Allowed root: ${allowedRoot}; requested: ${requested}`);
  }
  const targetCanonical = await canonicalForBoundary(requested);

  if (!isInside(rootCanonical, targetCanonical)) {
    throw new Error(
      `SECURITY: path outside allowed workspace. ` +
      `Allowed root: ${allowedRoot}; requested: ${requested}`
    );
  }

  // Reject links even when they currently point back into the workspace.
  let component = rootCanonical;
  for (const part of path.relative(rootCanonical, requested).split(path.sep).filter(Boolean)) {
    component = path.join(component, part);
    let stat;
    try {
      stat = await fsp.lstat(component);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      throw err;
    }
    const real = await fsp.realpath(component);
    if (stat.isSymbolicLink() || normalizeCompare(real) !== normalizeCompare(component)) {
      throw new Error(`SECURITY: reparse point in workspace path: ${component}`);
    }
  }

  /*
   * GPT 不允许直接碰 .git。
   * 防止写 hooks/config 后在未来 Git 操作中获得间接代码执行能力。
   */
  if (containsGitControlPath(requested)) {
    throw new Error(
      `SECURITY: direct access to .git is blocked: ${requested}`
    );
  }

  return requested;
}

export function assertNotWorkspaceRoot(candidate: string): void {
  if (normalizeCompare(candidate) === normalizeCompare(allowedRoot)) {
    throw new Error("SECURITY: operation on the workspace root is not allowed");
  }
}

/** Reject linked children before a recursive delete or directory move. */
export async function assertNoReparseTree(candidate: string): Promise<void> {
  await validatePath(candidate);
  const stat = await fsp.lstat(candidate);
  if (stat.isSymbolicLink()) throw new Error(`SECURITY: linked child: ${candidate}`);
  if (!stat.isDirectory()) return;
  for (const entry of await fsp.readdir(candidate)) {
    await assertNoReparseTree(path.join(candidate, entry));
  }
}

/**
 * 不再枚举 C:\ / D:\ / E:\ 等机器盘符。
 */
export function getMachineRoots(): string[] {
  return [allowedRoot];
}

/**
 * 启动时额外检查 workspace 本身不是一个指向外部位置的奇怪链接。
 */
export async function assertWorkspaceBoundary(): Promise<void> {
  await checkedRoot();
}
