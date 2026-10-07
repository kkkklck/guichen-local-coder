# Initial source release verification

Date: 2026-10-07. Version: 0.1.0. Platform: Windows, Node.js 24.19.0.

The source release was prepared separately from the running personal deployment. It did not modify that deployment, its workspace, credentials, Tunnel configuration, or startup entries.

| Check | Result |
| --- | --- |
| Lockfile install: `npm ci --ignore-scripts --no-audit --no-fund` | PASS, 115 packages |
| `npm run build` | PASS |
| `npm test` | PASS: patches, file tools, checkpoints, mock upstreams, OAuth persistence, logs, project context, tool profiles, path security, binary transfer, Shell state and policy |
| `test-setup.mjs` | PASS: new installation path containing spaces; separate random tokens; no token output/overwrite; isolated authenticated MCP service defaults to approval; Admin authentication; 26 tools; nested create/overwrite/delete; byte-exact binary write |
| `npm run test:session-resilience` | PASS: fresh initialization after DELETE, SSE disconnect, concurrent recovery, TTL, active requests, capacity 503, restart without duplicate recovery writes, and failed-recovery cleanup |
| `npm run test:tunnel` | PASS: 37 startup/connection/safe recovery/redaction assertions; simulated delayed network readiness, bounded restart after client exit, and credential redaction |
| Actual `tools/list` export | PASS: 26 tools saved to tools.schema.json; schema query only, no command execution |
| Repeated setup | PASS: existing .env retained; tokens not printed |
| Known deployment secret comparison | PASS: public sources and source archive do not contain the running deployment's Key, MCP/Admin tokens, or Tunnel ID |
| Comparison of core policy and IPC sources | PASS: Shell Guard, file boundaries, tool policy, and native approval scripts match the running deployment after normalizing line endings and final blank lines; no approval/denial protocol or execution-policy change |
| Public source scan | PASS: no matching credential patterns, runtime configuration, backups, logs, dependency directories, or bundled external executables |

The relocated supervisor test fixture required an explicit CommonJS package declaration because the main project uses ES Modules. The fixture passed after that correction; the real Tunnel mechanism was not changed for it.

This verification did not ask the user to click a new real approval window, connect a fresh machine to a real public Tunnel, or establish ChatGPT conversation attachment-byte compatibility. Local tests are not substitutes for those external acceptance checks.

The repository includes a GitHub Actions workflow. Its actual remote status is available in the repository's Actions tab; the local results above are independent of a remote CI run. Release scanning is neither exhaustive secret detection nor a third-party security audit. Other operating systems have not been verified, and this release does not claim OS sandboxing.
