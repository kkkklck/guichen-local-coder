import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { requestWindowsShellApproval } from "../dist/lib/shell-approval.js";

if (process.platform !== "win32") throw new Error("This test requires Windows PowerShell.");
const requestId = randomUUID();
const events = [];
const result = await requestWindowsShellApproval({
  requestId,
  command: "",
  workingDirectory: process.cwd(),
  purpose: "Verify a malformed approval request fails closed with a specific reason.",
  risk: "medium",
  reasons: [],
}, (event) => events.push(event));

assert.equal(result.requestId, requestId);
assert.equal(result.outcome, "ipc_error");
assert.equal(result.errorCategory, "request_validation_failed");
assert.match(result.errorCode, /^0x[0-9A-F]{8}$/);
assert.ok(result.exceptionType);
assert.ok(events.some((event) => event.stage === "request_matched"));
assert.ok(events.some((event) => event.stage === "server_received" && event.outcome === "ipc_error" && event.errorCategory === result.errorCategory));
assert.ok(!events.some((event) => event.stage === "dialog_shown"));
console.log(JSON.stringify({ result: "PASS", decision: result.outcome, error_category: result.errorCategory, executed: false, request_id: requestId }));
