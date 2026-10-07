import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { requireCommandAllowed } from "../lib/permissions.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { authorizeShellCommand, describeShellPolicy, getShellGuardMode, redactSensitiveCommand, type ShellApprovalEvent, type ShellApprovalOutcome } from "../lib/shell-approval.js";
import {
  bootstrapShellSession,
  applyCwdDirectives,
  execInShellSession,
  getShellStatus,
  resetShellSession,
  getWinShell,
  transpileCompoundOperators,
} from "../lib/persistent-shell.js";

interface ManagedProcess {
  id: string;
  requestId: string;
  command: string;
  cwd: string;
  startedAt: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  executionEventRecorded: boolean;
}

const processes = new Map<string, ManagedProcess>();
const MAX_LOG_CHARS = 400_000;

async function authorizeCommand(
  tool: string,
  command: string,
  cwd: string,
  purpose: string,
): Promise<Awaited<ReturnType<typeof authorizeShellCommand>>> {
  const requestId = randomUUID();
  return authorizeShellCommand(
    { requestId, command, workingDirectory: cwd, purpose, risk: "medium", reasons: [] },
    async (decision, assessment, id) => {
      await audit({
        tool,
        action: "shell_approval_decision",
        status: approvalAuditStatus(decision),
        details: {
          request_id: id,
          decision,
          guard_mode: getShellGuardMode(),
          risk: assessment.risk,
          reasons: assessment.reasons,
        },
      });
    },
    async (event) => logShellApprovalEvent(tool, event),
  );
}

function approvalAuditStatus(outcome?: ShellApprovalOutcome): "ok" | "error" | "blocked" {
  if (outcome === "approved") return "ok";
  if (outcome === "blocked" || outcome === "denied" || outcome === "window_closed") return "blocked";
  if (outcome) return "error";
  return "ok";
}

function approvalStageStatus(event: ShellApprovalEvent): "ok" | "error" | "blocked" {
  if (event.outcome) return approvalAuditStatus(event.outcome);
  if (event.stage === "window_error" || event.stage === "ipc_error" || event.stage === "execution_failed") return "error";
  if (event.stage === "user_clicked_deny" || event.stage === "window_closed" || event.stage === "request_blocked") return "blocked";
  return "ok";
}

async function logShellApprovalEvent(tool: string, event: ShellApprovalEvent): Promise<void> {
  await audit({
    tool,
    action: `shell_guard_${event.stage}`,
    status: approvalStageStatus(event),
    details: {
      request_id: event.requestId,
      stage: event.stage,
      ...(event.outcome ? { outcome: event.outcome } : {}),
      ...(event.exitCode !== undefined ? { exit_code: event.exitCode } : {}),
      ...(event.errorCategory ? { error_category: event.errorCategory } : {}),
      ...(event.errorCode ? { error_code: event.errorCode } : {}),
      ...(event.exceptionType ? { exception_type: event.exceptionType } : {}),
      ...(event.childPid !== undefined ? { child_pid: event.childPid } : {}),
      ...(event.payloadBytes !== undefined ? { payload_bytes: event.payloadBytes } : {}),
    },
  });
}

function deniedCommandResult(
  tool: string,
  decision: Awaited<ReturnType<typeof authorizeShellCommand>>,
) {
  const ipcReasons: Record<string, string> = {
    spawn_failed: "The Windows approval process could not start.",
    child_process_error: "The Windows approval process failed before returning a decision.",
    request_read_failed: "The Windows approval process could not read the request from its input pipe.",
    request_parse_failed: "The Windows approval process could not parse the request.",
    request_validation_failed: "The Windows approval process rejected the request data.",
    stdin_pipe_error: "The input pipe to the Windows approval process failed.",
    stdin_write_error: "The MCP server could not send the approval request.",
    response_send_failed: "The Windows approval process could not send its decision.",
    child_exited_without_response: "The Windows approval process exited without returning a decision.",
    invalid_or_missing_response: "The Windows approval process returned an invalid or empty decision.",
    request_id_mismatch: "The approval response did not match this request.",
    invalid_decision: "The Windows approval process returned an invalid decision.",
    child_exit_nonzero_after_response: "The Windows approval process failed after returning a decision.",
    stdout_limit_exceeded: "The approval response exceeded the allowed size.",
  };
  const messages: Record<ShellApprovalOutcome, string> = {
    approved: "The shell command was approved.",
    denied: "You denied this one-time shell request.",
    window_closed: "The approval window was closed without choosing Allow or Deny.",
    blocked: decision.assessment.blockReason || "The shell request was blocked by a local security rule.",
    timeout: "The one-time shell approval expired before a response was received; the command was not run.",
    window_error: "The Windows approval window failed; the command was not run.",
    ipc_error: `${ipcReasons[decision.errorCategory || ""] || "The Windows approval exchange failed."} The command was not run.`,
    execution_failed: "The approved command failed while executing.",
  };
  const reason = messages[decision.outcome];
  return toolResult(tool, {
    approved: false,
    decision: decision.outcome,
    request_id: decision.requestId,
    reason,
    riskChecks: decision.assessment.reasons,
    ...(decision.errorCategory ? { error_category: decision.errorCategory } : {}),
    ...(decision.errorCode ? { error_code: decision.errorCode } : {}),
    ...(decision.exceptionType ? { exception_type: decision.exceptionType } : {}),
  }, {
    ok: false,
    summary: reason,
  });
}

function appendLog(lines: string[], data: Buffer): void {
  lines.push(data.toString());
  let total = lines.reduce((sum, item) => sum + item.length, 0);
  while (total > MAX_LOG_CHARS && lines.length > 1) {
    const removed = lines.shift();
    total -= removed?.length || 0;
  }
}

export function registerShellTools(server: McpServer, defaultCwd: string, timeoutSec: number): void {
  void bootstrapShellSession(defaultCwd);

  server.registerTool(
    "run_command",
    {
      title: "Run Command",
      description:
        `Run a shell command with a working directory inside the file workspace. ${describeShellPolicy()} Include a clear purpose explaining what the command does and why it is needed. Use start_process for long jobs.`,
      inputSchema: {
        command: z.string(),
        purpose: z.string().trim().min(8).max(1200).describe("Explain what this exact command does and why it is needed; do not claim it is sandboxed."),
        working_directory: z.string().optional().describe("One-off override; does not reset persistent cwd unless you use shell_reset"),
      },

      annotations: toolAnnotations("command"),
    },
    async ({ command, purpose, working_directory }) => {
      requireCommandAllowed(command);
      const currentCwd = working_directory
        ? await validatePath(working_directory)
        : getShellStatus().cwd || defaultCwd;
      const plan = applyCwdDirectives(currentCwd, command);
      const cwd = await validatePath(plan.cwd);
      const decision = await authorizeCommand("run_command", command, cwd, purpose);
      if (!decision.approved) return deniedCommandResult("run_command", decision);
      await logShellApprovalEvent("run_command", { requestId: decision.requestId, stage: "execution_started", outcome: "approved" });
      try {
        const result = await execInShellSession(plan.command, defaultCwd, timeoutSec * 1000, cwd);
        const outcome = result.exit_code === 0 ? "approved" : "execution_failed";
        await logShellApprovalEvent("run_command", {
          requestId: decision.requestId,
          stage: result.exit_code === 0 ? "execution_completed" : "execution_failed",
          outcome,
          exitCode: result.exit_code,
        });
        await audit({
          tool: "run_command",
          action: "command",
          status: result.exit_code === 0 ? "ok" : "error",
          details: { request_id: decision.requestId, exit_code: result.exit_code },
        });
        return toolResult("run_command", { approved: true, authorization: decision.authorization, guard_mode: decision.guardMode, ...result, command: redactSensitiveCommand(result.command), request_id: decision.requestId }, {
          ok: result.exit_code === 0,
          summary: `exit ${result.exit_code} in ${result.cwd}`,
        });
      } catch (error) {
        await logShellApprovalEvent("run_command", { requestId: decision.requestId, stage: "execution_failed", outcome: "execution_failed" });
        throw error;
      }
    }
  );

  server.registerTool(
    "shell_status",
    {
      title: "Shell Status",
      description: "Show persistent shell session cwd and recent commands.",
      inputSchema: {},

      annotations: toolAnnotations("read"),
    },
    async () => {
      const status = getShellStatus();
      return toolResult("shell_status", { ...status, guard_mode: getShellGuardMode(), sandboxed: false, policy: describeShellPolicy() }, { summary: `cwd: ${status.cwd}` });
    }
  );

  server.registerTool(
    "shell_reset",
    {
      title: "Shell Reset",
      description: "Reset persistent shell cwd to a directory (default: workspace).",
      inputSchema: { path: z.string().optional() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: dirPath }) => {
      const cwd = dirPath ? await validatePath(dirPath) : defaultCwd;
      resetShellSession(cwd);
      return toolResult("shell_reset", { cwd }, { summary: `shell cwd reset to ${cwd}` });
    }
  );

  server.registerTool(
    "start_process",
    {
      title: "Start Background Process",
      description: `Start a long-running command in the background. ${describeShellPolicy()} Use process_output/process_status/stop_process afterwards.`,
      inputSchema: {
        command: z.string(),
        purpose: z.string().trim().min(8).max(1200).describe("Explain what this exact command does and why it is needed; do not claim it is sandboxed."),
        working_directory: z.string().optional(),
      },

      annotations: toolAnnotations("command"),
    },
    async ({ command, purpose, working_directory }) => {
      requireCommandAllowed(command);
      const cwd = working_directory ? await validatePath(working_directory) : getShellStatus().cwd || defaultCwd;
      const decision = await authorizeCommand("start_process", command, cwd, purpose);
      if (!decision.approved) return deniedCommandResult("start_process", decision);
      await logShellApprovalEvent("start_process", { requestId: decision.requestId, stage: "execution_started", outcome: "approved" });
      let shell = "bash";
      let effectiveCommand = command;
      let args = ["-lc", effectiveCommand];

      if (process.platform === "win32") {
        const winShellInfo = getWinShell();
        shell = winShellInfo.shell;
        if (!winShellInfo.isPwsh) {
          effectiveCommand = transpileCompoundOperators(command);
        }
        args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", effectiveCommand];
      }

      const child = spawn(shell, args, {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          CI: "true",
          PAGER: "cat",
          GIT_PAGER: "cat",
          NO_COLOR: "1",
        },
      });
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const item: ManagedProcess = {
        id,
        requestId: decision.requestId,
        command,
        cwd,
        startedAt: new Date().toISOString(),
        child,
        stdout: [],
        stderr: [],
        exitCode: null,
        signal: null,
        executionEventRecorded: false,
      };
      processes.set(id, item);
      child.stdout.on("data", (d: Buffer) => appendLog(item.stdout, d));
      child.stderr.on("data", (d: Buffer) => appendLog(item.stderr, d));
      child.on("close", (code, signal) => {
        item.exitCode = code;
        item.signal = signal;
        if (!item.executionEventRecorded) {
          item.executionEventRecorded = true;
          void logShellApprovalEvent("start_process", {
            requestId: item.requestId,
            stage: code === 0 ? "execution_completed" : "execution_failed",
            outcome: code === 0 ? "approved" : "execution_failed",
            exitCode: code,
          });
        }
      });
      child.on("error", () => {
        if (!item.executionEventRecorded) {
          item.executionEventRecorded = true;
          void logShellApprovalEvent("start_process", { requestId: item.requestId, stage: "execution_failed", outcome: "execution_failed" });
        }
      });
      await audit({ tool: "start_process", action: "start", status: "ok", details: { id, request_id: decision.requestId } });
      return toolResult("start_process", { approved: true, authorization: decision.authorization, guard_mode: decision.guardMode, request_id: decision.requestId, id, pid: child.pid, command: redactSensitiveCommand(command), cwd, started_at: item.startedAt }, {
        summary: `started ${id}`,
      });
    }
  );

  server.registerTool(
    "process_status",
    {
      title: "Process Status",
      description: "Show status of background process(es).",
      inputSchema: { id: z.string().optional() },

      annotations: toolAnnotations("read"),
    },
    async ({ id }) => {
      const processes_list = [...processes.values()]
        .filter((p) => !id || p.id === id)
        .map((p) => ({
          id: p.id,
          pid: p.child.pid,
          command: redactSensitiveCommand(p.command),
          cwd: p.cwd,
          started_at: p.startedAt,
          running: p.exitCode === null && p.signal === null,
          exit_code: p.exitCode,
          signal: p.signal,
        }));
      return toolResult("process_status", { processes: processes_list }, { summary: `${processes_list.length} process(es)` });
    }
  );

  server.registerTool(
    "process_output",
    {
      title: "Process Output",
      description: "Read stdout/stderr logs for a background process.",
      inputSchema: {
        id: z.string(),
        tail_chars: z.number().int().positive().max(200000).optional().default(40000),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ id, tail_chars }) => {
      const item = processes.get(id);
      if (!item) throw new Error(`Unknown process id: ${id}`);
      const data = {
        id,
        running: item.exitCode === null && item.signal === null,
        exit_code: item.exitCode,
        signal: item.signal,
        stdout: item.stdout.join("").slice(-tail_chars),
        stderr: item.stderr.join("").slice(-tail_chars),
      };
      return toolResult("process_output", data, { summary: `output for ${id}` });
    }
  );

  server.registerTool(
    "stop_process",
    {
      title: "Stop Process",
      description: "Stop a background process by id.",
      inputSchema: { id: z.string(), force: z.boolean().optional().default(false) },

      annotations: toolAnnotations("edit"),
    },
    async ({ id, force }) => {
      const item = processes.get(id);
      if (!item) throw new Error(`Unknown process id: ${id}`);
      if (item.exitCode !== null || item.signal !== null) {
        return toolResult("stop_process", { id, already_exited: true }, { summary: `${id} already exited` });
      }
      const stopPurpose =
        (force ? "Force-stop" : "Stop") +
        " the managed background process " +
        id +
        ", which is running this previously approved command.";
      const decision = await authorizeCommand(
        "stop_process",
        item.command,
        item.cwd,
        stopPurpose,
      );
      if (!decision.approved) return deniedCommandResult("stop_process", decision);
      await logShellApprovalEvent("stop_process", { requestId: decision.requestId, stage: "execution_started", outcome: "approved" });
      item.child.kill(force ? "SIGKILL" : "SIGTERM");
      await logShellApprovalEvent("stop_process", { requestId: decision.requestId, stage: "execution_completed", outcome: "approved" });
      await audit({ tool: "stop_process", action: "stop", status: "ok", details: { id, force, request_id: decision.requestId } });
      return toolResult("stop_process", { id, force }, { summary: `stop sent to ${id}` });
    }
  );

  server.registerTool(
    "clear_processes",
    {
      title: "Clear Finished Processes",
      description: "Remove finished process records from memory.",
      inputSchema: {},

      annotations: toolAnnotations("edit"),
    },
    async () => {
      let cleared = 0;
      for (const [id, item] of processes) {
        if (item.exitCode !== null || item.signal !== null) {
          processes.delete(id);
          cleared++;
        }
      }
      return toolResult("clear_processes", { cleared }, { summary: `cleared ${cleared}` });
    }
  );
}
