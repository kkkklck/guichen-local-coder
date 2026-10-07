# Contributing

Describe the trigger, expected behavior, and observed behavior. Use a temporary workspace and dummy credentials for reproductions. Do not attach raw private logs, real tokens, personal files, or private request screenshots.

Preserve the existing Windows Shell Guard approval IPC. Changes to IPC, path boundaries, execution entrances, risk policy, or MCP annotations need appropriate regression coverage. Do not re-enable Node REPL, direct Git, or delegated execution without a separate review. Do not describe trusted execution as a sandbox.

Run `npm ci`, `npm run build`, `npm test`, `npm run test:setup`, and `npm run test:session-resilience`. Windows tunnel changes also require `npm run test:tunnel`. Actual approval-button acceptance testing is a separate manual step; tests must not automatically approve real service requests.

Before committing, run `npm run check:release` and inspect the Git diff. The scanner is an additional check, not a guarantee that no secret is present. Explain new dependencies and prefer the existing stack. Do not bundle external executables or add network-dependent UI frameworks.

Use English for public documentation and commit messages. Keep the original command and AI explanation intact in approval requests; documentation translation must not change what the user is asked to approve.
