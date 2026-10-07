import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['.git', 'node_modules', 'dist', 'workspace', 'backups', 'security-backup', 'diagnostics', 'artifacts', '.tool-test-tmp']);
const forbidden = /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]*)?|tunnel-settings\.json|backups|security-backup|diagnostics|artifacts|workspace|node_modules|dist|\.mcp-[^/]+)(?:\/|$)|\.(?:log|exe|zip)$/i;
const patterns = [
  ['API key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/],
  ['GitHub token', /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['real tunnel identifier', /\btunnel_(?!0{31}[0-9a-f]\b)[0-9a-f]{32}\b/],
];
async function collect(dir = root) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.name.startsWith('.mcp-') || entry.name.startsWith('.lifecycle-')) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collect(file));
    else if (!entry.name.startsWith('.env') || entry.name === '.env.example') files.push(path.relative(root, file).replaceAll('\\', '/'));
  }
  return files;
}
let files;
try {
  execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
  if (!files.length) files = await collect();
} catch { files = await collect(); }
let findings = 0;
for (const name of files) {
  if (forbidden.test(name)) { console.error('FAIL forbidden release file: ' + name); findings++; continue; }
  const file = path.join(root, name);
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink()) { console.error('FAIL linked release file: ' + name); findings++; continue; }
  const bytes = await fs.readFile(file);
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) { console.error('FAIL ' + label + ' pattern in: ' + name); findings++; }
  }
}
if (findings) process.exitCode = 1;
else console.log(`PASS release scan: ${files.length} source files; no matching credentials or forbidden release files. This is not an exhaustive secret audit.`);
