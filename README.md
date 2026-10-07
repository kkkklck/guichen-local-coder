# Guichen Local Coder

[![Windows verification](https://github.com/kkkklck/guichen-local-coder/actions/workflows/ci.yml/badge.svg)](https://github.com/kkkklck/guichen-local-coder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A local MCP workstation bridge for ChatGPT in the browser: manage research files, transfer binary data, and run commands on your Windows computer.

This is a fork of [hoangcoderr/chatgpt-local-coder](https://github.com/hoangcoderr/chatgpt-local-coder). The Guichen edition adds workspace path checks, a native Windows Shell Guard dialog, verified binary uploads, and session recovery fixes. It retains the upstream MIT license and attribution. This is a community project, unaffiliated with OpenAI.

```text
ChatGPT / MCP client → HTTPS tunnel → Local MCP server → File tools / Shell Guard
```

## Features

- **Workspace file operations:** read, create, overwrite, edit, copy, move, and delete files throughout one configured directory and its ordinary subdirectories. Includes multi-file patches, audit events, and file checkpoints.
- **Binary uploads:** save Base64 bytes as real ZIP, PDF, PNG, DOCX, or other files. Chunked uploads verify sequence, total size, and final SHA-256 before publishing the destination.
- **Native Windows approval:** inspect the original command, working directory, AI explanation, and backend risk reasons. Denial, window closure, timeout, and IPC failure do not authorize execution.
- **Optional trusted execution:** explicitly opt into running commands without a local approval dialog after the existing block checks.
- **Session recovery:** reconnect after server restarts, coalesce concurrent recovery handshakes, remove closed transports, and bound idle session lifetime and capacity.
- **Optional Windows tunnel supervision:** wait for network readiness, refresh system proxy settings, apply bounded backoff, and report connection state with redacted diagnostics.

## Security model

| Operation | Behavior |
| --- | --- |
| Dedicated file tools | Restricted to one `WORKSPACE_PATH`, including ordinary descendants; traversal and linked paths are checked |
| File deletion | Requires an explicit validated path; workspace root deletion and direct `.git` access are blocked |
| Fixed diagnostic commands | Automatically allowed, for example `python --version` |
| Other Shell commands in `approval` mode | Require one-time approval in the native Windows dialog |
| Other Shell commands in `trusted` mode | Execute without the local dialog; existing block checks remain active |

**Workspace path checks are not an OS sandbox and retain TOCTOU risks. Shell commands and their child processes run with the current Windows user's permissions. Approved or trusted commands may access files, programs, and networks outside the workspace. A command blacklist cannot guarantee confinement. AI explanations are not a security guarantee.**

`approval` is the default. `trusted` is an explicit host configuration, not a permission that an AI tool argument can grant. ChatGPT's own tool confirmations are controlled by the client; MCP safety annotations are not disguised to suppress them. Shell side effects are not automatically covered by file-tool checkpoints.

See [SECURITY.md](SECURITY.md) for deployment and reporting guidance.

## Quick start

Primary verified platform: Windows 11 and Node.js 24. Node.js 22+ is required. Native approval and startup scripts use Windows PowerShell 5.1. Other operating systems have not completed acceptance testing.

```powershell
git clone https://github.com/kkkklck/guichen-local-coder.git
cd guichen-local-coder
npm ci
node scripts/setup.mjs
npm run build
npm start
```

The setup script creates `./workspace` and a local `.env` with separate random MCP and Admin tokens. It does not print tokens or overwrite an existing `.env`. Default Shell mode: `approval`.

To use another workspace, edit `WORKSPACE_PATH` in `.env` before starting. Configure exactly one existing ordinary directory. Its ordinary descendants are accessible; linked roots and multiple roots are rejected.

| Endpoint | Address |
| --- | --- |
| MCP service | `http://127.0.0.1:3000` |
| Health check | `http://127.0.0.1:3000/health` |
| MCP endpoint | `http://127.0.0.1:3000/mcp/<MCP_TOKEN>` |
| Local admin UI | `http://127.0.0.1:3001/ui` |

Read tokens only from your local `.env`; never publish the full authenticated endpoint. Admin APIs require `ADMIN_TOKEN`. Some admin UI labels retain the upstream language; the native Shell approval dialog currently uses Simplified Chinese.

If you choose trusted execution, set `SHELL_GUARD_MODE=trusted` in `.env` and restart the server after understanding the permissions described above.

## Connect a remote MCP client

Use your own HTTPS tunnel to forward requests to local port 3000, then configure the token-bearing MCP endpoint in your client. ChatGPT feature availability and connection settings depend on the current product and account. Refresh the client's tool list after changing tool definitions.

The optional OpenAI Tunnel integration is documented in [Windows tunnel setup](docs/windows-tunnel.md). No tunnel client, cloudflared executable, API key, Tunnel ID, or personal configuration is bundled. You need your own account and credentials.

## Available tools

The default profile exposes **26 tools**. The actual [`tools/list` snapshot](docs/tools.schema.json) includes input schemas and safety annotations.

| Category | Tools |
| --- | --- |
| Files and directories | `read_text_file`, `write_file`, `edit_file`, `multi_edit`, `apply_patch`, `glob`, `grep`, `list_directory`, `create_directory`, `delete_file`, `delete_directory`, `copy_file`, `move_file` |
| Binary transfer | `write_binary_file`, `begin_upload`, `upload_chunk`, `finish_upload` |
| Shell and processes | `run_command`, `shell_status`, `shell_reset`, `start_process`, `process_status`, `process_output`, `stop_process` |
| Existing document helpers | `extract_pdf_text`, `convert_document_text` |

Direct Git tools, Node REPL, MCP delegation, and other unreviewed execution entrances remain disabled. This edition does not expose every upstream tool. Optional PDF extraction requires a trusted `pdftotext` installation outside the workspace; configure `PDFTOTEXT_PATH` if needed. That executable is not bundled.

**Receiving binary bytes does not mean every ChatGPT conversation can transmit attachment bytes.** The client must obtain the complete file bytes, encode them as Base64, and submit tool arguments. A `sandbox:/mnt/data/...` path is neither a Windows path nor a public download URL. Local transfer tests do not establish attachment compatibility in every ChatGPT environment. See the [binary upload protocol](docs/binary-upload.md).

## Development and verification

```powershell
npm run build
npm test
npm run test:setup
npm run test:session-resilience
npm run test:tunnel
npm run check:release
```

Routine tests use temporary directories and mock services. `test:tunnel` includes isolated supervisor tests and does not read real credentials. Its optional `test-proxy-routing.mjs` test requires a separately installed tunnel client and is not part of the default suite.

`test-live-*`, `test-phase1-security`, approval E2E drivers, and UI capture scripts are manual acceptance tools. They may connect to a running service or display real windows; do not run them in unattended CI or with a personal deployment's `.env`.

Session defaults: `MCP_SESSION_TTL_MS=1800000`, `MCP_SESSION_MAX=512`, and `MCP_SESSION_RECOVERY_TIMEOUT_MS=10000`. Idle cleanup does not terminate active or queued requests. If all session slots are busy, the server returns 503 with a retry hint. Session recovery does not replay a tool after dispatch has begun. Client retries of side-effecting operations still require care.

Rate limiting, authentication failures, and lost connectivity are different conditions. Restart loops are not a workaround for remote 429 responses.

The [release verification record](docs/release-verification.md) describes local checks and their limits. To regenerate the schema snapshot, run `npm run tools:schema`.

## Contributing and attribution

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [NOTICE.md](NOTICE.md). Preserve the approval IPC, path checks, and honest tool annotations. Never commit credentials, runtime logs, backups, workspace contents, or screenshots of private requests.

Licensed under [MIT](LICENSE). Upstream author: **hoangcoderr**. Guichen modifications: **Guichen Local Coder contributors**.
