import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Annotations describe effects, not authority. Shell commands have a separate
 * Shell Guard policy; MCP hints never select its authorization mode.
 */
export type ToolRisk = "read" | "create" | "edit" | "command" | "destructive";

export function toolAnnotations(risk: ToolRisk): ToolAnnotations {
  if (risk === "read") {
    return { readOnlyHint: true, openWorldHint: false };
  }
  if (risk === "create") {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  }
  return {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: risk === "command",
    idempotentHint: false,
  };
}
