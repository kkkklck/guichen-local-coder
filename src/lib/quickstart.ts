import { describeShellPolicy } from "./shell-approval.js";

export const MCP_QUICKSTART = `
## Workspace-only file workflow
- Dedicated file-tool paths are restricted to the authorized workspace shown below.
- Explore with glob, grep, list_directory, and read_text_file.
- Create, edit, move, copy, and delete ordinary workspace files directly with the file tools; do not request Shell approval for those operations.
- Plan related file changes together and use apply_patch for a multi-file create/update/delete batch or multi_edit for several replacements in one file. Checkpoint and audit records remain available.
- Use extract_pdf_text and convert_document_text for PDF/DOCX reading before asking to run a general Python or PowerShell script.
- ${describeShellPolicy()}
- The existing command block rules apply in both modes. They are best-effort checks, not an OS sandbox or a guarantee that arbitrary scripts cannot access other directories.
- The working directory must remain inside the workspace, but shell programs use the current Windows account's permissions. Shell edits are audited as executions; file-tool checkpoints do not automatically capture every shell file change.
- File-tool path validation is an application-layer guard, not an OS sandbox; concurrent local changes to paths can create a residual TOCTOU race.
- Git tools, Node REPL, and upstream MCP delegation remain disabled.
- Prefer the authorized workspace for tasks; do not bypass the remaining command block rules or use disabled execution tools.

## Output format
All tools return JSON: { ok, tool, summary, data }
`.trim();

export function buildServerInstructions(
  workspaceRoot: string,
  workspaceRoots: string[],
  _fullDiskAccess: boolean,
  contextBlock?: string
): string {
  const header = [
    "# Codex Local Coder MCP",
    `Default project: ${workspaceRoot}`,
    "Dedicated file tools: workspace-only. Host Shell: current Windows user permissions, not an OS sandbox.",
    describeShellPolicy(),
    "Git tools, Node REPL, and upstream MCP delegation remain disabled.",
  ].join("\n");

  const footer = [
    "## Quick pointers",
    `Authorized workspace: ${workspaceRoot}`,
    "File-tool paths outside this workspace are blocked. Existing shell block rules remain active, but arbitrary shell code can access other directories with the current user's permissions. Shell file changes are not automatically covered by file-tool checkpoints.",
  ].join("\n");

  const body = contextBlock?.trim();
  if (!body) return `${header}\n\n${footer}`;
  return `${header}\n\n${body}\n\n${footer}`;
}
