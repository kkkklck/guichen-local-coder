import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID, type Hash } from "node:crypto";
import { audit } from "./audit.js";
import { checkpointBefore } from "./checkpoint.js";
import { assertNotWorkspaceRoot, getAllowedRoots, validatePath } from "./path-security.js";

export const MAX_BINARY_BYTES = 512 * 1024 * 1024;
export const MAX_BINARY_CHUNK_BYTES = 2 * 1024 * 1024;
export const BINARY_UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_ACTIVE_UPLOADS = 4;
const STAGING_NAME = ".guichen-upload-staging";

interface UploadSession {
  id: string;
  destination: string;
  temporaryPath: string;
  handle: FileHandle | null;
  expectedBytes: number;
  expectedHash: string;
  receivedBytes: number;
  nextIndex: number;
  hash: Hash;
  updatedAt: number;
  busy: boolean;
  device: number;
  inode: number;
}

export interface UploadFinished {
  path: string;
  size_bytes: number;
  sha256: string;
  checkpoint_id: string | null;
}

/** Base64 must be complete and canonical: Buffer.from alone silently ignores bad characters. */
export function decodeBinaryChunk(value: string): Buffer {
  if (value.length > Math.ceil(MAX_BINARY_CHUNK_BYTES / 3) * 4) throw new Error("Upload chunk exceeds 2 MiB");
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Upload chunk is not canonical Base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_BINARY_CHUNK_BYTES || bytes.toString("base64") !== value) {
    throw new Error("Upload chunk is not canonical Base64 or exceeds 2 MiB");
  }
  return bytes;
}

export class BinaryUploadManager {
  private sessions = new Map<string, UploadSession>();
  private stagingDirectory: string | null = null;
  private initialization: Promise<void> | null = null;
  private readonly timeoutMs: number;

  constructor(timeoutMs = BINARY_UPLOAD_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
    const timer = setInterval(() => { void this.cleanupExpired().catch(() => {}); }, Math.min(60_000, Math.max(1000, timeoutMs)));
    timer.unref();
  }

  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initializeOnce().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    await this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    const root = getAllowedRoots()[0];
    await validatePath(root);
    const staging = await validatePath(path.join(root, STAGING_NAME));
    try { await fs.mkdir(staging); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await validatePath(staging);
    const stat = await fs.lstat(staging);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("SECURITY: upload staging is not an ordinary directory");
    this.stagingDirectory = staging;
    await this.removeStaleStagingFiles();
  }

  private async removeStaleStagingFiles(): Promise<void> {
    if (!this.stagingDirectory) return;
    await validatePath(this.stagingDirectory);
    for (const entry of await fs.readdir(this.stagingDirectory, { withFileTypes: true })) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/.test(entry.name)) continue;
      if (entry.isDirectory()) continue;
      const file = path.join(this.stagingDirectory, entry.name);
      const id = entry.name.slice(0, -5);
      if (this.sessions.has(id)) continue;
      const stat = await fs.lstat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs >= this.timeoutMs) {
        await fs.unlink(file).catch(() => {});
      }
    }
  }

  async cleanupExpired(): Promise<void> {
    await this.initialize();
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (!session.busy && now - session.updatedAt >= this.timeoutMs) await this.discard(session, "timeout");
    }
    await this.removeStaleStagingFiles();
  }

  private async checkTemporaryFile(session: UploadSession): Promise<void> {
    await validatePath(session.temporaryPath);
    const stat = await fs.lstat(session.temporaryPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== session.device || stat.ino !== session.inode) {
      throw new Error("SECURITY: upload staging file changed during transfer");
    }
  }

  private async discard(session: UploadSession, reason: string): Promise<void> {
    this.sessions.delete(session.id);
    if (session.handle) {
      await session.handle.close().catch(() => {});
      session.handle = null;
    }
    try {
      await validatePath(session.temporaryPath);
      await fs.unlink(session.temporaryPath);
    } catch { /* Fail closed if the staging path changed. */ }
    await audit({ tool: "write_binary_file", action: "upload_discard", target: session.destination, status: "blocked", details: { session_id: session.id, reason, received_bytes: session.receivedBytes } });
  }

  private async sessionFor(id: string): Promise<UploadSession> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Unknown upload session");
    if (session.busy) throw new Error("Upload session is busy");
    if (Date.now() - session.updatedAt >= this.timeoutMs) {
      await this.discard(session, "timeout");
      throw new Error("Upload session timed out");
    }
    return session;
  }

  async begin(destinationInput: string, sizeBytes: number, sha256: string): Promise<{ session_id: string; next_index: number; max_chunk_bytes: number; expires_in_ms: number }> {
    await this.initialize();
    await this.cleanupExpired();
    if (this.sessions.size >= MAX_ACTIVE_UPLOADS) throw new Error("Too many active uploads");
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_BINARY_BYTES) throw new Error("Invalid upload size");
    if (!/^[0-9a-fA-F]{64}$/.test(sha256)) throw new Error("Invalid SHA-256 digest");
    const destination = await validatePath(destinationInput);
    assertNotWorkspaceRoot(destination);
    const staging = this.stagingDirectory!;
    const relativeToStaging = path.relative(staging, destination);
    if (!relativeToStaging || (relativeToStaging !== ".." && !relativeToStaging.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToStaging))) {
      throw new Error("SECURITY: upload destination cannot be the staging directory");
    }
    const existing = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Destination is not an ordinary file");
    const id = randomUUID();
    const temporaryPath = await validatePath(path.join(this.stagingDirectory!, `${id}.part`));
    const handle = await fs.open(temporaryPath, "wx+");
    const stat = await handle.stat();
    const session: UploadSession = {
      id, destination, temporaryPath, handle, expectedBytes: sizeBytes,
      expectedHash: sha256.toLowerCase(), receivedBytes: 0, nextIndex: 0,
      hash: createHash("sha256"), updatedAt: Date.now(), busy: false,
      device: stat.dev, inode: stat.ino,
    };
    this.sessions.set(id, session);
    await audit({ tool: "begin_upload", action: "upload_begin", target: destination, status: "ok", details: { session_id: id, size_bytes: sizeBytes, sha256: session.expectedHash } });
    return { session_id: id, next_index: 0, max_chunk_bytes: MAX_BINARY_CHUNK_BYTES, expires_in_ms: this.timeoutMs };
  }

  async append(id: string, index: number, contentBase64: string): Promise<{ session_id: string; next_index: number; received_bytes: number }> {
    const session = await this.sessionFor(id);
    if (session.busy) throw new Error("Upload session is busy");
    session.busy = true;
    try {
      if (index !== session.nextIndex) throw new Error(`Upload chunk out of order; expected index ${session.nextIndex}`);
      const bytes = decodeBinaryChunk(contentBase64);
      if (bytes.length === 0 || session.receivedBytes + bytes.length > session.expectedBytes) throw new Error("Upload chunk exceeds declared size or is empty");
      await this.checkTemporaryFile(session);
      let written = 0;
      while (written < bytes.length) {
        const result = await session.handle!.write(bytes, written, bytes.length - written, session.receivedBytes + written);
        if (result.bytesWritten === 0) throw new Error("Upload write made no progress");
        written += result.bytesWritten;
      }
      session.hash.update(bytes);
      session.receivedBytes += bytes.length;
      session.nextIndex++;
      session.updatedAt = Date.now();
      return { session_id: id, next_index: session.nextIndex, received_bytes: session.receivedBytes };
    } catch (error) {
      await this.discard(session, "chunk_rejected");
      throw error;
    } finally {
      session.busy = false;
    }
  }

  async finish(id: string): Promise<UploadFinished> {
    const session = await this.sessionFor(id);
    if (session.busy) throw new Error("Upload session is busy");
    session.busy = true;
    try {
      if (session.receivedBytes !== session.expectedBytes) throw new Error("Upload is incomplete");
      const actualHash = session.hash.digest("hex");
      if (actualHash !== session.expectedHash) throw new Error("Upload SHA-256 mismatch");
      await this.checkTemporaryFile(session);
      await session.handle!.sync();
      await session.handle!.close();
      session.handle = null;
      await fs.mkdir(path.dirname(session.destination), { recursive: true });
      await validatePath(session.destination);
      await this.checkTemporaryFile(session);
      const checkpointId = await checkpointBefore("write_binary_file", [session.destination]);
      await validatePath(session.destination);
      await this.checkTemporaryFile(session);
      await fs.rename(session.temporaryPath, session.destination);
      this.sessions.delete(session.id);
      await audit({ tool: "finish_upload", action: "upload_finish", target: session.destination, status: "ok", details: { session_id: id, size_bytes: session.receivedBytes, sha256: actualHash, checkpoint_id: checkpointId } });
      return { path: session.destination, size_bytes: session.receivedBytes, sha256: actualHash, checkpoint_id: checkpointId };
    } catch (error) {
      await this.discard(session, "finish_rejected");
      throw error;
    } finally {
      session.busy = false;
    }
  }

  async writeSingle(destination: string, sizeBytes: number, sha256: string, contentBase64: string): Promise<UploadFinished> {
    const bytes = decodeBinaryChunk(contentBase64);
    if (bytes.length !== sizeBytes) throw new Error("Binary input size does not match declared size");
    const started = await this.begin(destination, sizeBytes, sha256);
    try {
      if (bytes.length > 0) await this.append(started.session_id, 0, contentBase64);
      return await this.finish(started.session_id);
    } catch (error) {
      const session = this.sessions.get(started.session_id);
      if (session) await this.discard(session, "single_rejected");
      throw error;
    }
  }

  async abort(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) await this.discard(session, "aborted");
  }
}

export const binaryUploadManager = new BinaryUploadManager();
