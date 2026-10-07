import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dialogPath = path.join(repoRoot, "scripts", "shell-approval-dialog.ps1");
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const requestId = `dialog-selftest-${randomUUID()}`;
const request = {
  requestId,
  command: "python -c \"print('APPROVAL_OK')\"",
  purpose: "Verify that a denied approval response is returned without running the command.",
  workingDirectory: process.env.WORKSPACE_PATH || repoRoot,
  risk: "medium",
  reasons: ["This command requires a one-time approval."],
};

const result = await new Promise((resolve, reject) => {
  const child = spawn(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-STA", "-WindowStyle", "Hidden", "-File", dialogPath, "-SelfTest", "-RequestId", requestId,
  ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout, stderr }));
  child.stdin.end(JSON.stringify(request), "utf8");
});

if (result.code !== 0) {
  const response = JSON.parse(result.stdout.trim());
  console.error(JSON.stringify({ code: result.code, decision: response.decision, category: response.errorCategory, error_code: response.errorCode, exception: response.exceptionType }));
}
assert.equal(result.code, 0, "dialog self-test should exit successfully");
const responseLines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
assert.equal(responseLines.length, 1, "stdout must contain exactly one protocol response line");
const response = JSON.parse(responseLines[0]);
assert.equal(response.requestId, requestId, "response must correlate to its request");
assert.equal(response.decision, "denied", "self-test must deny without approving");
const events = result.stderr.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
assert.deepEqual(events.map((event) => event.stage), ["ipc_request_read", "dialog_shown", "test_auto_denied", "result_sent"]);
assert.ok(events.every((event) => event.requestId === requestId), "every dialog event must carry the request id");
assert.ok(!result.stdout.includes("APPROVAL_OK"), "the sample command must never run in dialog self-test");
console.log("PASS dialog IPC emits only one correlated JSON response on stdout");
console.log("PASS dialog self-test records shown, test-denied, and result-sent stages");

const malformedId = `dialog-malformed-${randomUUID()}`;
const malformed = await new Promise((resolve, reject) => {
  const child = spawn(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-STA", "-WindowStyle", "Hidden", "-File", dialogPath, "-RequestId", malformedId,
  ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout, stderr }));
  child.stdin.end("{broken-json", "utf8");
});
const malformedResponse = JSON.parse(malformed.stdout.trim());
assert.equal(malformed.code, 1);
assert.equal(malformedResponse.requestId, malformedId);
assert.equal(malformedResponse.decision, "ipc_error");
assert.equal(malformedResponse.errorCategory, "request_parse_failed");
assert.match(malformedResponse.errorCode, /^0x[0-9A-F]{8}$/);
assert.ok(malformedResponse.exceptionType);
const malformedEvents = malformed.stderr.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
assert.deepEqual(malformedEvents.map((event) => event.stage), ["ipc_request_read", "ipc_error"]);
assert.ok(malformedEvents.every((event) => event.requestId === malformedId));
console.log("PASS malformed IPC input retains request ID, exception type, and error code");
