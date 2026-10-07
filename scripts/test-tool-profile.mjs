/**
 * Verify slim tool profile exposes expected tools only.
 */
import { SLIM_CHATGPT_TOOLS, shouldExposeTool } from "../dist/lib/tool-profile.js";

const ALL_KNOWN = [
  "read_text_file", "write_file", "apply_patch", "glob", "grep", "run_command",
  "git_status", "mcp_call", "delete_directory", "read_file_base64",
];

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

try {
  if (SLIM_CHATGPT_TOOLS.size < 18) throw new Error(`slim set too small: ${SLIM_CHATGPT_TOOLS.size}`);
  ok(`slim profile has ${SLIM_CHATGPT_TOOLS.size} tools`);

  for (const t of ["read_text_file", "apply_patch", "glob"]) {
    if (!shouldExposeTool(t, "slim")) throw new Error(`${t} missing from slim`);
  }
  ok("core tools exposed in slim");

  for (const t of ["run_command", "shell_status", "shell_reset", "start_process", "process_status", "process_output", "stop_process"]) {
    if (!shouldExposeTool(t, "slim")) throw new Error(`${t} missing from slim approval-gated shell`);
  }
  ok("approval-gated shell controls exposed in slim");

  if (shouldExposeTool("mcp_call", "slim")) throw new Error("mcp_call should be hidden in slim");
  for (const t of ["delete_file", "create_directory", "delete_directory", "copy_file", "move_file", "extract_pdf_text", "convert_document_text"]) {
    if (!shouldExposeTool(t, "slim")) throw new Error(`${t} missing from slim`);
  }
  ok("workspace file and document tools exposed in slim");

  for (const t of ["write_binary_file", "begin_upload", "upload_chunk", "finish_upload"]) {
    if (!shouldExposeTool(t, "slim")) throw new Error(`${t} missing from slim`);
  }
  ok("binary upload tools exposed in slim");

  if (shouldExposeTool("mcp_call", "full")) throw new Error("mcp_call must remain disabled in every profile");
  if (shouldExposeTool("node_repl", "full")) throw new Error("node_repl must remain disabled in every profile");
  ok("full profile still respects the hard security denylist");
} catch (e) {
  fail("tool profile", e.message || e);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
