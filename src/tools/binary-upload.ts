import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { binaryUploadManager, MAX_BINARY_BYTES, MAX_BINARY_CHUNK_BYTES } from "../lib/binary-upload.js";
import { requireWriteAllowed } from "../lib/permissions.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";

const pathField = z.string().min(1).describe("Destination file inside the authorized workspace WORKSPACE_PATH. Absolute and relative workspace paths are accepted; links and escapes are rejected.");
const sizeField = z.number().int().nonnegative().max(MAX_BINARY_BYTES).describe("Exact decoded file size in bytes, at most 512 MiB.");
const hashField = z.string().regex(/^[0-9a-fA-F]{64}$/).describe("SHA-256 of the complete original file, as 64 hexadecimal characters.");
const base64Field = z.string().max(Math.ceil(MAX_BINARY_CHUNK_BYTES / 3) * 4).describe("Canonical standard Base64, with padding, representing at most 2 MiB of raw bytes. No data URL prefix.");
const temporaryWriteHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function registerBinaryUploadTools(server: McpServer): void {
  server.registerTool(
    "write_binary_file",
    {
      title: "Write Binary File",
      description: "Write complete Base64 bytes to a real workspace file after exact size and SHA-256 verification. For files above 2 MiB use begin_upload, upload_chunk, finish_upload. This tool does not fetch ChatGPT attachments by path or URL, run the file, or invoke Shell.",
      inputSchema: { path: pathField, size_bytes: sizeField.max(MAX_BINARY_CHUNK_BYTES), sha256: hashField, content_base64: base64Field },
      annotations: toolAnnotations("edit"),
    },
    async ({ path, size_bytes, sha256, content_base64 }) => {
      requireWriteAllowed();
      const result = await binaryUploadManager.writeSingle(path, size_bytes, sha256, content_base64);
      return toolResult("write_binary_file", result);
    }
  );

  server.registerTool(
    "begin_upload",
    {
      title: "Begin Binary Upload",
      description: "Reserve a single destination file in WORKSPACE_PATH and start a temporary upload. Declare the exact total byte count and complete-file SHA-256 before sending chunks. Returns a unique session_id. Nothing is saved at the destination yet.",
      inputSchema: { path: pathField, size_bytes: sizeField, sha256: hashField },
      annotations: temporaryWriteHints,
    },
    async ({ path, size_bytes, sha256 }) => {
      requireWriteAllowed();
      const result = await binaryUploadManager.begin(path, size_bytes, sha256);
      return toolResult("begin_upload", result);
    }
  );

  server.registerTool(
    "upload_chunk",
    {
      title: "Upload Binary Chunk",
      description: "Append one canonical Base64 chunk to an existing upload session. Index starts at 0 and must increase by exactly 1. Each chunk may contain at most 2 MiB of raw bytes. An invalid or out-of-order chunk cancels the upload.",
      inputSchema: {
        session_id: z.string().uuid().describe("Unique session_id returned by begin_upload."),
        index: z.number().int().nonnegative().describe("Zero-based sequential chunk index."),
        content_base64: base64Field,
      },
      annotations: temporaryWriteHints,
    },
    async ({ session_id, index, content_base64 }) => {
      requireWriteAllowed();
      const result = await binaryUploadManager.append(session_id, index, content_base64);
      return toolResult("upload_chunk", result);
    }
  );

  server.registerTool(
    "finish_upload",
    {
      title: "Finish Binary Upload",
      description: "Verify the received byte count and SHA-256, then move the completed temporary file into its exact workspace destination. An incomplete, expired, or mismatched upload is discarded and cannot overwrite the destination.",
      inputSchema: { session_id: z.string().uuid().describe("Unique session_id returned by begin_upload.") },
      annotations: toolAnnotations("edit"),
    },
    async ({ session_id }) => {
      requireWriteAllowed();
      const result = await binaryUploadManager.finish(session_id);
      return toolResult("finish_upload", result);
    }
  );
}
