import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assessShellCommand, authorizeShellCommand, getShellGuardMode, describeShellPolicy } from "../dist/lib/shell-approval.js";
import { buildServerInstructions } from "../dist/lib/quickstart.js";
import { toolAnnotations } from "../dist/lib/tool-annotations.js";

const original = process.env.SHELL_GUARD_MODE;
const originalLegacy = process.env.CHATGPT_AUTO_APPROVE;
try {
  delete process.env.SHELL_GUARD_MODE;
  assert.equal(getShellGuardMode(), "approval", "default retains one-time approval");
  process.env.SHELL_GUARD_MODE = " TRUSTED ";
  assert.equal(getShellGuardMode(), "trusted");
  const commands = ["python -c \"print('TRUSTED_OK')\"", "python -m pytest", "npm test", "Get-Content README.md", "Set-Content result.txt hello"];
  for (const command of commands) {
    assert.equal(assessShellCommand(command).decision, "approval", "trusted mode must not relabel code as a safe diagnostic");
    const requestId = randomUUID();
    const events = [];
    const decisions = [];
    const result = await authorizeShellCommand({ requestId, command, workingDirectory: process.cwd(), purpose: "Verify trusted execution policy without starting a command.", risk: "medium", reasons: [] }, async (...args) => decisions.push(args), (event) => events.push(event));
    assert.equal(result.approved, true);
    assert.equal(result.authorization, "trusted");
    assert.equal(result.guardMode, "trusted");
    assert.equal(result.requestId, requestId);
    assert.equal(result.assessment.decision, "approval");
    assert.ok(events.some(event => event.stage === "trusted_allow"));
    assert.ok(events.every(event => event.requestId === requestId));
    assert.ok(!events.some(event => ["dialog_started", "user_clicked_allow", "ipc_ready"].includes(event.stage)));
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0][0], "approved");
  }
  for (const command of ["Format-Volume -DriveLetter E", "Set-MpPreference -DisableRealtimeMonitoring $true", "Get-Content .env", "Get-Content .git/config", "Get-Content C:\\Windows\\win.ini", "rm -rf /", "dd if=/dev/zero of=/dev/sda", "Start-Process powershell -Verb RunAs"]) {
    const events = [];
    const result = await authorizeShellCommand({ requestId: randomUUID(), command, workingDirectory: process.cwd(), purpose: "Check command block rules without executing the command.", risk: "high", reasons: [] }, async () => {}, event => events.push(event));
    assert.equal(result.approved, false, command);
    assert.equal(result.outcome, "blocked");
    assert.equal(result.authorization, "blocked");
    assert.ok(!events.some(event => ["trusted_allow", "dialog_started"].includes(event.stage)));
  }
  const diagnostics = await authorizeShellCommand({ requestId: randomUUID(), command: "python --version", workingDirectory: process.cwd(), purpose: "Verify diagnostic authorization remains distinct.", risk: "medium", reasons: [] }, async () => {});
  assert.equal(diagnostics.authorization, "diagnostic");
  assert.equal(diagnostics.assessment.risk, "low");
  assert.match(describeShellPolicy(), /current Windows user's permissions/);
  const instructions = buildServerInstructions("E:\\gptonline", ["E:\\gptonline"], false);
  assert.match(instructions, /trusted mode/);
  assert.match(instructions, /without a local approval dialog/);
  assert.match(instructions, /not an OS sandbox/);
  assert.match(instructions, /file-tool checkpoints/i);
  assert.deepEqual(toolAnnotations("command"), { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false });
  process.env.CHATGPT_AUTO_APPROVE = "true";
  delete process.env.SHELL_GUARD_MODE;
  assert.equal(getShellGuardMode(), "approval", "legacy flag cannot enable trusted execution");
  process.env.SHELL_GUARD_MODE = "typo";
  assert.throws(() => getShellGuardMode(), /Invalid SHELL_GUARD_MODE/);
  await assert.rejects(() => authorizeShellCommand({ requestId: randomUUID(), command: "python --version", workingDirectory: process.cwd(), purpose: "Verify invalid mode fails closed.", risk: "medium", reasons: [] }, async () => {}), /Invalid SHELL_GUARD_MODE/);
  console.log("PASS trusted execution without native dialog, distinct authorization and correlated audit events");
  console.log("PASS block rules before trusted authorization; risk assessment and MCP annotations unchanged");
  console.log("PASS truthful instructions, default approval, invalid mode fails closed, legacy flag ignored");
} finally {
  if (original === undefined) delete process.env.SHELL_GUARD_MODE;
  else process.env.SHELL_GUARD_MODE = original;
  if (originalLegacy === undefined) delete process.env.CHATGPT_AUTO_APPROVE;
  else process.env.CHATGPT_AUTO_APPROVE = originalLegacy;
}
