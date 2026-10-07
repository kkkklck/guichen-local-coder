# Security boundaries and reporting

This MCP service runs under the local Windows user account. Workspace checks and Shell Guard are not OS isolation. Dedicated file tools have a single-root boundary, but application-level path checks retain TOCTOU risks between validation and filesystem operations. They do not promise protection against a hostile local process continuously replacing paths. General Shell execution may use all permissions available to the account.

Fresh installations use `approval` mode. `trusted` is an explicit opt-in to unsandboxed execution. Both retain existing command block checks, but a blacklist cannot enumerate every program's behavior. AI explanations are informational and cannot grant system permissions. Never disguise tool annotations as read-only to bypass client approval.

The service binds to 127.0.0.1 by default. Set random `MCP_TOKEN` and `ADMIN_TOKEN` values before exposing a remote tunnel; the setup script generates both. The MCP token is part of the URL and must not be pasted into issues, screenshots, or logs. Do not expose the admin port publicly or place credentials and runtime configuration inside the file workspace.

Binary uploads do not execute their content, but writes can overwrite workspace data. File checkpoints do not cover all file sizes, Shell side effects, or network actions, and are not a complete backup.

Report exploitable vulnerabilities privately through the repository's GitHub **Security → Report a vulnerability** entry if available. If that entry is unavailable, ask the maintainer for a private reporting route without publishing exploit details or secrets in an issue. Do not assume a public issue is confidential.

For an exposed vulnerable instance or credential leak, stop exposing the affected instance and rotate compromised credentials. Do not post real keys, private files, or details that can be used against a live instance.
