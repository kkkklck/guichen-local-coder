import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { requestWindowsShellApproval } from "../dist/lib/shell-approval.js";

if (process.platform !== "win32") throw new Error("This test requires Windows PowerShell and the native approval dialog.");
const requestId = randomUUID();
const events = [];
const result = await requestWindowsShellApproval({
  requestId,
  command: "python -c \"print('APPROVAL_OK')\"",
  workingDirectory: process.cwd(),
  purpose: "Verify the approval timeout closes without executing the command.",
  risk: "medium",
  reasons: ["Timeout test; no decision will be made."],
}, (event) => events.push(event), 1500);

assert.equal(result.requestId, requestId);
assert.equal(result.outcome, "timeout");
assert.ok(events.some((event) => event.stage === "dialog_shown"), "approval window should have been displayed");
assert.ok(events.some((event) => event.stage === "server_received" && event.outcome === "timeout" && event.errorCategory === "approval_timeout"));
const exitDeadline = Date.now() + 5000;
while (!events.some((event) => event.stage === "process_exited") && Date.now() < exitDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
assert.ok(events.some((event) => event.stage === "process_exited"), "timed-out approval child should exit after cancellation");
console.log(JSON.stringify({ result: "PASS", decision: result.outcome, executed: false, request_id: requestId }));
