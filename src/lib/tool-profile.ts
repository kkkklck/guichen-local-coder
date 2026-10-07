import fs from "fs";
import path from "path";

export type ToolProfileName = "full" | "slim";

export const LOCAL_TOOL_CATALOG = [
  "read_text_file", "write_file", "edit_file", "multi_edit", "apply_patch", "glob", "grep", "list_directory",
  "delete_file", "create_directory", "delete_directory", "copy_file", "move_file", "extract_pdf_text", "convert_document_text",
  "write_binary_file", "begin_upload", "upload_chunk", "finish_upload",
  "run_command", "shell_status", "shell_reset", "start_process", "process_status", "process_output", "stop_process", "node_repl", "ponytail_turn",
  "git_status", "git_diff", "git_add", "git_commit", "git_restore", "agent_status", "project_context",
  "remember", "load_path_rules", "list_skills", "load_skill", "rewind", "mcp_servers", "mcp_tools", "mcp_call",
];

interface LocalToolOverrides {
  enabled?: string[];
  disabled?: string[];
}

// Keep unguarded code execution, Git mutation tools, and upstream delegation
// disabled even if an override file is missing, malformed, or edited in the UI.
// Shell Guard keeps its block rules; host configuration selects approval or trusted mode.
const ALWAYS_DISABLED_TOOLS = new Set([
  "clear_processes",
  "node_repl", "ponytail_turn",
  "git_status", "git_diff", "git_log", "git_add", "git_commit",
  "git_branch", "git_checkout", "git_restore", "git_push", "git_pull",
  "git_stash", "git_reset",
  "mcp_servers", "mcp_tools", "mcp_call",
  "remember", "rewind",
  "agent_status", "project_context", "load_path_rules", "list_skills", "load_skill",
]);

const overridesPath = () => path.resolve(process.cwd(), "profiles", "tool-overrides.json");

export function getLocalToolOverrides(): LocalToolOverrides {
  try {
    const raw = fs.readFileSync(overridesPath(), "utf-8").replace(/^\uFEFF/, "");
    return JSON.parse(raw) as LocalToolOverrides;
  } catch {
    return {};
  }
}

export function saveLocalToolOverrides(next: LocalToolOverrides): void {
  fs.mkdirSync(path.dirname(overridesPath()), { recursive: true });
  fs.writeFileSync(overridesPath(), JSON.stringify(next, null, 2));
}

/** Core tools for ChatGPT web — smaller tools/list payload, fewer discovery errors. */
export const SLIM_CHATGPT_TOOLS = new Set([
  "read_text_file",
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "glob",
  "grep",
  "list_directory",
  "delete_file",
  "create_directory",
  "delete_directory",
  "copy_file",
  "move_file",
  "extract_pdf_text",
  "convert_document_text",
  "write_binary_file",
  "begin_upload",
  "upload_chunk",
  "finish_upload",
  "run_command",
  "shell_status",
  "shell_reset",
  "start_process",
  "process_status",
  "process_output",
  "stop_process",
  "git_status",
  "git_diff",
  "git_add",
  "git_commit",
  "git_restore",
  "agent_status",
  "project_context",
  "remember",
  "load_path_rules",
  "list_skills",
  "load_skill",
  "node_repl",
  "ponytail_turn",
  "rewind",
  "mcp_servers",
]);

export function getChatGptToolProfile(): ToolProfileName {
  const raw = (process.env.CHATGPT_TOOL_PROFILE || "slim").trim().toLowerCase();
  return raw === "full" ? "full" : "slim";
}

export function shouldExposeTool(name: string, profile: ToolProfileName = getChatGptToolProfile()): boolean {
  if (ALWAYS_DISABLED_TOOLS.has(name)) return false;
  const overrides = getLocalToolOverrides();
  if ((overrides.disabled ?? []).includes(name)) return false;
  if (profile === "full") return true;
  return SLIM_CHATGPT_TOOLS.has(name) || (overrides.enabled ?? []).includes(name);
}
