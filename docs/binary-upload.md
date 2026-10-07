# Binary upload protocol

The MCP `tools/list` response is the authoritative schema. Required parameters are summarized below. Every destination uses the existing workspace path checks. No Shell command or uploaded content is executed.

| Tool | Required parameters |
| --- | --- |
| `write_binary_file` | `path: string`, `size_bytes: integer`, `sha256: string`, `content_base64: string` |
| `begin_upload` | `path: string`, `size_bytes: integer`, `sha256: string` |
| `upload_chunk` | `session_id: UUID string`, `index: nonnegative integer`, `content_base64: string` |
| `finish_upload` | `session_id: UUID string` |

A single write or chunk accepts at most 2 MiB of raw bytes. Chunked files may total up to 512 MiB, with at most four active uploads and a 15-minute upload lifetime. Base64 must be canonical standard Base64 with required padding and no data URL prefix. SHA-256 is the complete original file's digest as 64 hexadecimal characters.

For a small file, call `write_binary_file` directly. For a large file, call `begin_upload` with the exact total size and digest, retain its unique `session_id`, send chunks with `index=0,1,2,...`, and call `finish_upload`. Incomplete, expired, out-of-order, or hash-mismatched transfers are not published to the destination. Overwrites use the existing checkpoint mechanism. Compare the original and received file's SHA-256 to verify the transfer.

These tools receive bytes. The client must obtain the complete attachment or generated-file bytes and submit Base64. The tools do not resolve ChatGPT sandbox paths as Windows paths, fetch URLs automatically, extract ZIP archives, or execute received files.

`write_binary_file` and `finish_upload` can overwrite files and declare the corresponding write/destructive attributes. Temporary chunk tools declare non-read-only, non-idempotent behavior rather than pretending to be pure queries. MCP clients may still require their own confirmation.

See [tools.schema.json](tools.schema.json) for the full schema snapshot.
