import { CODEX_AGENT_PROMPT } from "./codex-agent-prompt.js";
import { formatEnvironmentForInstructions, type GitSnapshot } from "./git-snapshot.js";
import type { ProjectMemoryBundle } from "./project-memory.js";
import { getChatGptToolProfile } from "./tool-profile.js";
import { buildServerInstructions } from "./quickstart.js";

export interface InstructionContextOptions {
  workspaceRoot: string;
  workspaceRoots: string[];
  pid: number;
  adminPort: number;
}

export interface InstructionContext {
  projectMemory: ProjectMemoryBundle;
  git: GitSnapshot;
  instructionsText: string;
  instructionBytes: number;
}

export async function buildInstructionContext(
  opts: InstructionContextOptions
): Promise<InstructionContext> {
  // Phase 1 reads no project instructions, Git metadata, user auto-memory, or
  // globally installed skills. MCP file tools enforce the workspace boundary.
  const projectMemory: ProjectMemoryBundle = {
    root: opts.workspaceRoot,
    workspace_roots: [opts.workspaceRoot],
    sections: [],
    total_bytes: 0,
    loaded_at: new Date().toISOString(),
  };
  const git: GitSnapshot = {
    is_repo: false,
    error: "Git metadata loading is disabled in Phase 1",
  };

  const profile = getChatGptToolProfile();

  const blocks = [
    CODEX_AGENT_PROMPT,
    `Tool profile: **${profile}** (Phase 1 capability denylist remains enforced).`,
    formatEnvironmentForInstructions({
      workspaceRoot: opts.workspaceRoot,
      workspaceRoots: opts.workspaceRoots,
      pid: opts.pid,
      adminPort: opts.adminPort,
      nodeVersion: process.version,
    }),
  ].filter(Boolean);

  const projectMemoryBlock = blocks.join("\n\n");
  const instructionsText = buildServerInstructions(
    opts.workspaceRoot,
    opts.workspaceRoots,
    false,
    projectMemoryBlock
  );

  return {
    projectMemory,
    git,
    instructionsText,
    instructionBytes: Buffer.byteLength(instructionsText, "utf-8"),
  };
}

export function summarizeInstructionContext(ctx: InstructionContext): Record<string, unknown> {
  return {
    root: ctx.projectMemory.root,
    workspace_roots: ctx.projectMemory.workspace_roots,
    memory_files: ctx.projectMemory.sections.map((s) => ({
      path: s.path,
      kind: s.kind,
      truncated: s.truncated,
    })),
    memory_bytes: ctx.projectMemory.total_bytes,
    instruction_bytes: ctx.instructionBytes,
    git: ctx.git.is_repo
      ? { branch: ctx.git.branch, commits: ctx.git.recent_commits?.length ?? 0 }
      : { is_repo: false },
    loaded_at: ctx.projectMemory.loaded_at,
    tool_profile: getChatGptToolProfile(),
  };
}
