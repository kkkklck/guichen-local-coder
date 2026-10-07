import { assessShellCommand, describeShellPolicy } from "./shell-approval.js";

export type PermissionProfile = "workspace";

export function getPermissionProfile(): PermissionProfile {
  return "workspace";
}

export function isReadOnly(): boolean {
  return false;
}

export function canWriteFiles(): boolean {
  return true;
}

export function canRunCommands(): boolean {
  return true;
}

export function canUseAnyAbsolutePath(): boolean {
  return false;
}

export function shouldBlockCommand(command: string): boolean {
  return assessShellCommand(command).decision === "blocked";
}

export function describePermissionProfile(): string {
  return `File tools are restricted to WORKSPACE_PATH. ${describeShellPolicy()}`;
}

export function requireWriteAllowed(): void {
  // File writes are allowed only after validatePath() passes.
}

export function requireCommandAllowed(command: string): void {
  if (typeof command !== "string" || !command.trim()) {
    throw new Error("SECURITY: empty shell commands are not allowed");
  }
}
