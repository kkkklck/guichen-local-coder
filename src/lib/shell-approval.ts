import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ShellDecision = "auto" | "approval" | "blocked";
export type ShellGuardMode = "approval" | "trusted";
export type ShellAuthorization = "diagnostic" | "trusted" | "one_time" | "blocked";

/** Explicit host setting only. MCP arguments and AI risk explanations cannot select it. */
export function getShellGuardMode(): ShellGuardMode {
  const value = (process.env.SHELL_GUARD_MODE || "approval").trim().toLowerCase();
  if (value !== "approval" && value !== "trusted") {
    throw new Error("Invalid SHELL_GUARD_MODE: expected approval or trusted; shell execution refused.");
  }
  return value;
}

export function describeShellPolicy(): string {
  return getShellGuardMode() === "trusted"
    ? "Shell Guard trusted mode: commands that pass the existing block rules execute without a local approval dialog, using the current Windows user's permissions. This is not a sandbox or a guarantee of workspace confinement."
    : "Shell Guard approval mode: only fixed read-only diagnostics execute automatically; other commands require one-time native Windows approval. Approved commands use the current Windows user's permissions and are not sandboxed.";
}
export interface ShellAssessment {
  decision: ShellDecision;
  risk: "low" | "medium" | "high";
  reasons: string[];
  blockReason?: string;
}
export interface ShellApprovalRequest {
  requestId: string;
  command: string;
  workingDirectory: string;
  purpose: string;
  risk: "medium" | "high";
  reasons: string[];
}
export type ShellApprovalOutcome = "approved" | "denied" | "window_closed" | "blocked" | "timeout" | "window_error" | "ipc_error" | "execution_failed";
export type ShellApprovalStage =
  | "request_created"
  | "dialog_started"
  | "ipc_ready"
  | "ipc_request_sent"
  | "ipc_request_read"
  | "request_matched"
  | "process_exited"
  | "dialog_shown"
  | "user_clicked_allow"
  | "user_clicked_deny"
  | "test_auto_denied"
  | "window_error"
  | "ipc_error"
  | "window_closed"
  | "result_sent"
  | "server_received"
  | "automatic_allow"
  | "trusted_allow"
  | "request_blocked"
  | "decision_finalized"
  | "execution_started"
  | "execution_completed"
  | "execution_failed";
export interface ShellApprovalEvent {
  requestId: string;
  stage: ShellApprovalStage;
  outcome?: ShellApprovalOutcome;
  exitCode?: number | null;
  errorCategory?: string;
  errorCode?: string;
  exceptionType?: string;
  payloadBytes?: number;
  childPid?: number;
}
export type ShellApprovalLogger = (event: ShellApprovalEvent) => Promise<void> | void;
export interface ShellApprovalResult {
  outcome: ShellApprovalOutcome;
  requestId: string;
  errorCategory?: string;
  errorCode?: string;
  exceptionType?: string;
}
const DIALOG_SCRIPT = fileURLToPath(new URL("../../scripts/shell-approval-dialog.ps1", import.meta.url));
const AUTO_COMMANDS = [
  /^(?:pwd|Get-Location)$/i,
  /^(?:ls|dir|Get-ChildItem)$/i,
  /^(?:node|npm|pnpm|yarn|python|python3|py|git)\s+(?:--version|-V)$/i,
  /^\$PSVersionTable\.PSVersion$/i,
];
const BLOCK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(?:^|[\s"' ])(?:E:\\GPTLocalBridge|C:\\Windows\\win\.ini|C:\\Users\\[^\\\s]+\\\.ssh|\\\\[^\\]+)/i, reason: "This request explicitly targets a path outside the authorized workspace." },
  { pattern: /(?:^|[\s"'\\/])\.\.[\\/]+|(?:^|[\s"' ])\.\.(?=[\s"' ;|&]|$)/, reason: "Parent-directory traversal is blocked for shell commands." },
  { pattern: /(?:^|[\s"' ])[^\r\n]*\.git(?:[\\/]|)/i, reason: "Direct access to Git control files is blocked." },
  { pattern: /(?:Get-Content|Set-Content|Add-Content|Out-File|type|cat|gc|sc)\b[^\r\n]*(?:\.env|id_rsa|id_ed25519|known_hosts|credentials(?:\.|\\)|secrets?\.|(?:api|access|refresh)[_-]?key)/i, reason: "Commands that read or write likely credential files are blocked." },
  { pattern: /(?:Get-ChildItem|dir|ls|Get-ItemProperty|reg(?:\.exe)?\s+(?:query|export)|cmdkey)\b[^\r\n]*(?:Env:|Environment|Credential|Vault|SAM\\|SYSTEM\\CurrentControlSet\\Services\\WinDefend)/i, reason: "Commands that enumerate environment secrets or credential stores are blocked." },
  { pattern: /\$env:(?:OPENAI|MCP|CHATGPT)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|(?:cmdkey\b|Get-Credential\b|CredentialManager|PasswordVault)/i, reason: "Direct access to API credentials or the Windows credential store is blocked." },
  { pattern: /(?:Get-Content|Set-Content|Add-Content|Out-File|Remove-Item|Copy-Item|Move-Item|Set-Location|cd)\b[^\r\n]*(?:\$env:USERPROFILE|\$HOME|%USERPROFILE%|%APPDATA%|~\\)/i, reason: "Commands that explicitly access the user profile or AppData outside the workspace are blocked." },
  { pattern: /(?:-EncodedCommand|-enc\s|FromBase64String)/i, reason: "Encoded or obfuscated PowerShell commands are blocked because their full behavior cannot be reviewed." },
  { pattern: /(?:Set-MpPreference\b[^\r\n]*-DisableRealtimeMonitoring\s+\$?true|(?:Stop-Service|sc(?:\.exe)?)\s+(?:-Name\s+)?WinDefend\b|netsh\s+advfirewall\b[^\r\n]*\bstate\s+off|reg(?:\.exe)?\s+add\b[^\r\n]*(?:DisableAntiSpyware|EnableLUA))/i, reason: "Disabling endpoint protection, the firewall, or core security settings is blocked." },
  { pattern: /(?:Format-Volume|Format-Disk|Clear-Disk|diskpart\b|bcdedit\b|cipher\s+\/w:|Remove-Item\b[^\r\n]*-Recurse[^\r\n]*[A-Z]:\\(?:\s|$)|rd\s+\/s\s+\/q\s+[A-Z]:\\)/i, reason: "This command can erase a volume or alter boot/security configuration and is blocked." },
  { pattern: /\brm\s+(?:-[A-Za-z]+\s+)*-(?:[A-Za-z]*r[A-Za-z]*f|[A-Za-z]*f[A-Za-z]*r)[A-Za-z]*\s+(?:--\s+)?["']?\/(?:["']?(?:\s|$)|\*)|\bdd\b[^\r\n]*\bof=\/(?:dev|proc|sys)\//i, reason: "This command can erase a filesystem or overwrite a device and is blocked." },
  { pattern: /\bStart-Process\b[^\r\n]*-Verb\s+["']?RunAs\b|\brunas(?:\.exe)?\b/i, reason: "Requests to elevate privileges or switch Windows users are blocked." },
  { pattern: /(?:Invoke-Expression|\biex\b)\b[^\r\n]*?(?:Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\bcurl(?:\.exe)?\b|\bwget\b)|(?:Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\bcurl(?:\.exe)?\b|\bwget\b)[^\r\n]*\|\s*(?:Invoke-Expression|\biex)\b/i, reason: "Downloading and immediately executing remote code is blocked." },
];
export function redactSensitiveCommand(command: string): string {
  return command
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|mcp[_-]?token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;|&]+)/gi, "$1[REDACTED]");
}
function findOutsideAbsolutePath(command: string, workspaceRoot: string): string | undefined {
  const executableAtStart = command.match(/^\s*(?:&\s*)?(?:"([^"\r\n]+\.exe)"|'([^'\r\n]+\.exe)'|([A-Za-z]:\\[^\s;|&]+\.exe))\s*/i);
  const remainder = executableAtStart ? command.slice(executableAtStart[0].length) : command;
  const workspace = path.win32.resolve(workspaceRoot).replace(/[\\/]+$/, "").toLowerCase();
  const candidates = remainder.matchAll(/(?:^|[\s"'=])([A-Za-z]:\\[^\s"'`;|&,<>]*)/g);

  for (const match of candidates) {
    const candidate = path.win32.resolve(match[1].replace(/[),]+$/, "")).toLowerCase();
    if (candidate === workspace || candidate.startsWith(`${workspace}\\`)) continue;
    return match[1];
  }
  return undefined;
}

export function assessShellCommand(
  command: string,
  workspaceRoot = (process.env.WORKSPACE_PATH || process.cwd()).split(";")[0],
): ShellAssessment {
  const normalized = command.trim();
  if (!normalized) return { decision: "blocked", risk: "high", reasons: ["No command was provided."], blockReason: "An empty command cannot be run." };
  for (const entry of BLOCK_PATTERNS) {
    if (entry.pattern.test(normalized)) return { decision: "blocked", risk: "high", reasons: [entry.reason], blockReason: entry.reason };
  }
  if (/(?:^|[\\/])\.git(?:[\\/]|$)/i.test(normalized)) {
    const reason = "Direct access to Git control files is blocked.";
    return { decision: "blocked", risk: "high", reasons: [reason], blockReason: reason };
  }
  const outsidePath = findOutsideAbsolutePath(normalized, workspaceRoot);
  if (outsidePath) {
    const reason = `This command explicitly references a path outside the authorized workspace: ${outsidePath}`;
    return { decision: "blocked", risk: "high", reasons: [reason], blockReason: reason };
  }
  if (AUTO_COMMANDS.some((pattern) => pattern.test(normalized))) {
    return { decision: "auto", risk: "low", reasons: ["This exact command is on the narrow, read-only local diagnostic allowlist."] };
  }
  const reasons = ["This command is not on the narrow automatic allowlist."];
  if (/[|;&<>\x60]|\r|\n/.test(normalized)) reasons.push("It contains command chaining, redirection, a pipeline, or multiple lines.");
  if (/\b(?:npm|pnpm|yarn|pip|python|python3|py|node|npx|git|dotnet|cargo|go)\b/i.test(normalized)) reasons.push("It invokes a runtime, package manager, build tool, or Git, which can execute project or configured code.");
  if (/\b(?:install|add|remove|uninstall|delete|move|rename|copy|write|set-content|out-file|remove-item|invoke-expression|iex)\b/i.test(normalized)) reasons.push("It appears to change files, install software, or evaluate code.");
  if (/\b(?:https?:\/\/|curl|wget|invoke-webrequest|invoke-restmethod)\b/i.test(normalized)) reasons.push("It may communicate with an external service.");
  if (reasons.length === 1) reasons.push("Its effects cannot be determined safely from a fixed rule.");
  return { decision: "approval", risk: reasons.length > 2 ? "high" : "medium", reasons };
}
const DIALOG_TIMEOUT_MS = 120_000;
const CHILD_OUTPUT_LIMIT = 16_384;

async function logShellApproval(logger: ShellApprovalLogger | undefined, event: ShellApprovalEvent): Promise<void> {
  try { await logger?.(event); } catch { /* Logging must never change the approval result. */ }
}

function safeNodeError(error: unknown): Pick<ShellApprovalEvent, "errorCode" | "exceptionType"> {
  if (!(error instanceof Error)) return {};
  const code = (error as NodeJS.ErrnoException).code;
  return {
    ...(typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? { errorCode: code } : {}),
    ...(typeof error.name === "string" && /^[A-Za-z]{1,80}$/.test(error.name) ? { exceptionType: error.name } : {}),
  };
}

function isShellApprovalStage(value: unknown): value is ShellApprovalStage {
  return typeof value === "string" && [
    "ipc_request_read", "dialog_shown", "user_clicked_allow", "user_clicked_deny", "test_auto_denied", "window_closed", "window_error", "ipc_error", "result_sent",
  ].includes(value);
}

export function requestWindowsShellApproval(
  request: ShellApprovalRequest,
  logger?: ShellApprovalLogger,
  timeoutMs = DIALOG_TIMEOUT_MS,
): Promise<ShellApprovalResult> {
  const failBeforeSpawn = async (outcome: "window_error" | "ipc_error", errorCategory: string, error?: unknown) => {
    const diagnostic = safeNodeError(error);
    await logShellApproval(logger, { requestId: request.requestId, stage: outcome, outcome, errorCategory, ...diagnostic });
    return { outcome, requestId: request.requestId, errorCategory, ...diagnostic };
  };
  if (process.platform !== "win32") return failBeforeSpawn("window_error", "unsupported_platform");
  if (!fs.existsSync(DIALOG_SCRIPT)) return failBeforeSpawn("window_error", "dialog_script_missing");
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!fs.existsSync(powershell)) return failBeforeSpawn("window_error", "powershell_missing");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-WindowStyle", "Hidden", "-File", DIALOG_SCRIPT, "-RequestId", request.requestId], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      void failBeforeSpawn("ipc_error", "spawn_failed", error).then(resolve);
      return;
    }
    const output: Buffer[] = [];
    let outputSize = 0;
    let stderrBuffer = "";
    let settled = false;
    let eventQueue = Promise.resolve();
    const emit = (event: ShellApprovalEvent) => {
      eventQueue = eventQueue.then(() => logShellApproval(logger, event));
      return eventQueue;
    };
    const finish = (outcome: ShellApprovalOutcome, diagnostic: Pick<ShellApprovalResult, "errorCategory" | "errorCode" | "exceptionType"> = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ outcome, requestId: request.requestId, ...diagnostic });
    };
    const timeout = setTimeout(() => {
      void (async () => {
        await emit({ requestId: request.requestId, stage: "server_received", outcome: "timeout", errorCategory: "approval_timeout", childPid: child.pid });
        child.kill();
        finish("timeout", { errorCategory: "approval_timeout" });
      })();
    }, timeoutMs);
    void emit({ requestId: request.requestId, stage: "dialog_started", childPid: child.pid });
    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > CHILD_OUTPUT_LIMIT) {
        child.kill();
        void emit({ requestId: request.requestId, stage: "server_received", outcome: "ipc_error", errorCategory: "stdout_limit_exceeded", childPid: child.pid });
        finish("ipc_error", { errorCategory: "stdout_limit_exceeded" });
      } else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { requestId?: unknown; stage?: unknown; errorCategory?: unknown; errorCode?: unknown; exceptionType?: unknown; payloadBytes?: unknown };
          if (event.requestId === request.requestId && isShellApprovalStage(event.stage)) {
            void emit({
              requestId: request.requestId,
              stage: event.stage,
              childPid: child.pid,
              ...(typeof event.errorCategory === "string" ? { errorCategory: event.errorCategory } : {}),
              ...(typeof event.errorCode === "string" && /^0x[0-9a-fA-F]{8}$/.test(event.errorCode) ? { errorCode: event.errorCode } : {}),
              ...(typeof event.exceptionType === "string" && /^[A-Za-z.]{1,120}$/.test(event.exceptionType) ? { exceptionType: event.exceptionType } : {}),
              ...(typeof event.payloadBytes === "number" && Number.isSafeInteger(event.payloadBytes) && event.payloadBytes >= 0 ? { payloadBytes: event.payloadBytes } : {}),
            });
          }
        } catch { /* Ignore non-protocol diagnostics; never persist their text. */ }
      }
      if (stderrBuffer.length > CHILD_OUTPUT_LIMIT) stderrBuffer = "";
    });
    child.on("error", (error) => {
      const diagnostic = { errorCategory: "child_process_error", ...safeNodeError(error) };
      void emit({ requestId: request.requestId, stage: "server_received", outcome: "ipc_error", childPid: child.pid, ...diagnostic });
      finish("ipc_error", diagnostic);
    });
    child.stdin.on("error", (error) => {
      const diagnostic = { errorCategory: "stdin_pipe_error", ...safeNodeError(error) };
      void emit({ requestId: request.requestId, stage: "server_received", outcome: "ipc_error", childPid: child.pid, ...diagnostic });
      child.kill();
      finish("ipc_error", diagnostic);
    });
    child.on("close", (code) => {
      void emit({ requestId: request.requestId, stage: "process_exited", exitCode: code, childPid: child.pid });
      if (settled) return;
      let response: { requestId?: unknown; decision?: unknown; errorCategory?: unknown; errorCode?: unknown; exceptionType?: unknown };
      try { response = JSON.parse(Buffer.concat(output).toString("utf8")) as typeof response; }
      catch {
        void emit({ requestId: request.requestId, stage: "server_received", outcome: "ipc_error", errorCategory: code === 0 ? "invalid_or_missing_response" : "child_exited_without_response", childPid: child.pid, exitCode: code });
        void eventQueue.then(() => finish("ipc_error", { errorCategory: code === 0 ? "invalid_or_missing_response" : "child_exited_without_response" }));
        return;
      }
      if (response.requestId !== request.requestId) {
        void emit({ requestId: request.requestId, stage: "server_received", outcome: "ipc_error", errorCategory: "request_id_mismatch", childPid: child.pid, exitCode: code });
        void eventQueue.then(() => finish("ipc_error", { errorCategory: "request_id_mismatch" }));
        return;
      }
      void emit({ requestId: request.requestId, stage: "request_matched", childPid: child.pid, exitCode: code });
      const outcome = response.decision;
      if (outcome !== "approved" && outcome !== "denied" && outcome !== "window_closed" && outcome !== "window_error" && outcome !== "ipc_error") {
        void emit({ requestId: request.requestId, stage: "server_received", outcome: "ipc_error", errorCategory: "invalid_decision", childPid: child.pid, exitCode: code });
        void eventQueue.then(() => finish("ipc_error", { errorCategory: "invalid_decision" }));
        return;
      }
      if (code !== 0 && outcome !== "window_error" && outcome !== "ipc_error") {
        void emit({ requestId: request.requestId, stage: "server_received", outcome: "ipc_error", errorCategory: "child_exit_nonzero_after_response", childPid: child.pid, exitCode: code });
        void eventQueue.then(() => finish("ipc_error", { errorCategory: "child_exit_nonzero_after_response" }));
        return;
      }
      void (async () => {
        await emit({
          requestId: request.requestId,
          stage: "server_received",
          outcome,
          childPid: child.pid,
          exitCode: code,
          ...(typeof response.errorCategory === "string" ? { errorCategory: response.errorCategory } : {}),
          ...(typeof response.errorCode === "string" && /^0x[0-9a-fA-F]{8}$/.test(response.errorCode) ? { errorCode: response.errorCode } : {}),
          ...(typeof response.exceptionType === "string" && /^[A-Za-z.]{1,120}$/.test(response.exceptionType) ? { exceptionType: response.exceptionType } : {}),
        });
        finish(outcome, {
          ...(typeof response.errorCategory === "string" ? { errorCategory: response.errorCategory } : {}),
          ...(typeof response.errorCode === "string" && /^0x[0-9a-fA-F]{8}$/.test(response.errorCode) ? { errorCode: response.errorCode } : {}),
          ...(typeof response.exceptionType === "string" && /^[A-Za-z.]{1,120}$/.test(response.exceptionType) ? { exceptionType: response.exceptionType } : {}),
        });
      })();
    });
    void emit({ requestId: request.requestId, stage: "ipc_ready", childPid: child.pid });
    try {
      const payload = JSON.stringify(request);
      child.stdin.end(payload, "utf8", () => {
        void emit({ requestId: request.requestId, stage: "ipc_request_sent", childPid: child.pid, payloadBytes: Buffer.byteLength(payload, "utf8") });
      });
    }
    catch (error) {
      child.kill();
      const diagnostic = { errorCategory: "stdin_write_error", ...safeNodeError(error) };
      void emit({ requestId: request.requestId, stage: "server_received", outcome: "ipc_error", childPid: child.pid, ...diagnostic });
      finish("ipc_error", diagnostic);
    }
  });
}
export async function authorizeShellCommand(
  request: ShellApprovalRequest,
  auditDecision: (decision: ShellApprovalOutcome, assessment: ShellAssessment, requestId: string) => Promise<void>,
  logger?: ShellApprovalLogger,
): Promise<{ approved: boolean; assessment: ShellAssessment; requestId: string; outcome: ShellApprovalOutcome; authorization: ShellAuthorization; guardMode: ShellGuardMode; errorCategory?: string; errorCode?: string; exceptionType?: string }> {
  const guardMode = getShellGuardMode();
  const requestId = request.requestId || randomUUID();
  const correlatedRequest = { ...request, requestId };
  await logShellApproval(logger, { requestId, stage: "request_created" });
  const assessment = assessShellCommand(request.command);
  if (assessment.decision === "blocked") {
    await logShellApproval(logger, { requestId, stage: "request_blocked", outcome: "blocked" });
    await auditDecision("blocked", assessment, requestId);
    await logShellApproval(logger, { requestId, stage: "decision_finalized", outcome: "blocked" });
    return { approved: false, assessment, requestId, outcome: "blocked", authorization: "blocked", guardMode };
  }
  if (assessment.decision === "auto") {
    await logShellApproval(logger, { requestId, stage: "automatic_allow", outcome: "approved" });
    await auditDecision("approved", assessment, requestId);
    await logShellApproval(logger, { requestId, stage: "decision_finalized", outcome: "approved" });
    return { approved: true, assessment, requestId, outcome: "approved", authorization: "diagnostic", guardMode };
  }
  // Keep assessment and block rules intact. Trusted execution is an explicit
  // user's host policy, not a low-risk classification or a fabricated click.
  if (guardMode === "trusted") {
    await logShellApproval(logger, { requestId, stage: "trusted_allow", outcome: "approved" });
    await auditDecision("approved", assessment, requestId);
    await logShellApproval(logger, { requestId, stage: "decision_finalized", outcome: "approved" });
    return { approved: true, assessment, requestId, outcome: "approved", authorization: "trusted", guardMode };
  }
  const result = await requestWindowsShellApproval({
    ...correlatedRequest,
    risk: assessment.risk === "high" ? "high" : "medium",
    reasons: assessment.reasons,
  }, logger);
  const approved = result.outcome === "approved";
  await auditDecision(result.outcome, assessment, requestId);
  await logShellApproval(logger, { requestId, stage: "decision_finalized", outcome: result.outcome });
  return { approved, assessment, requestId, outcome: result.outcome, authorization: "one_time", guardMode, errorCategory: result.errorCategory, errorCode: result.errorCode, exceptionType: result.exceptionType };
}
