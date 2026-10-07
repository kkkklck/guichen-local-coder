# Guichen Local Coder contributor instructions

This is a clean source export, separate from the user's running deployment. Do not read or change another installation's credentials, Tunnel settings, startup entries or workspace as part of tests.

Keep exactly one configurable file workspace and its ordinary descendants. Preserve traversal/link checks, root deletion protection, audit and checkpoints. Application checks are not an OS sandbox and have residual TOCTOU risk.

Preserve the Windows approval IPC and fail-closed decisions. Default mode is approval; trusted is an explicit host configuration using unsandboxed account permissions. Do not claim that arbitrary Shell code is confined to the workspace. Never mislabel MCP safety annotations to bypass client approval.

Direct Git, Node REPL, upstream delegation and rewind stay hard-disabled. Do not re-enable hidden execution entrances or modify safety policy merely to improve packaging.

Build and run relevant regression tests. Use isolated fixtures; live E2E/UI tests require deliberate manual invocation. Do not print or commit tokens, runtime credentials, private logs, backup environments or personal attachments.
