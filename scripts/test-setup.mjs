import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'guichen-setup with spaces-'));
await fs.mkdir(path.join(fixture, 'scripts'));
await fs.copyFile(path.join(root, 'scripts/setup.mjs'), path.join(fixture, 'scripts/setup.mjs'));
await fs.copyFile(path.join(root, '.env.example'), path.join(fixture, '.env.example'));
async function setup() {
  const child = spawn(process.execPath, ['scripts/setup.mjs'], { cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  assert.equal((await once(child, 'exit'))[0], 0);
  return output;
}
async function port() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const number = server.address().port; await new Promise(resolve => server.close(resolve)); return number;
}
let server, client;
try {
  const output = await setup();
  const first = await fs.readFile(path.join(fixture, '.env'), 'utf8');
  const config = parse(first);
  assert.match(config.MCP_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.match(config.ADMIN_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(config.MCP_TOKEN, config.ADMIN_TOKEN);
  assert.ok(!output.includes(config.MCP_TOKEN) && !output.includes(config.ADMIN_TOKEN));
  assert.equal(config.SHELL_GUARD_MODE, 'approval');
  await setup(); assert.equal(await fs.readFile(path.join(fixture, '.env'), 'utf8'), first);
  const mcpPort = await port(); let adminPort = await port(); while (adminPort === mcpPort) adminPort = await port();
  const workspace = path.join(fixture, 'workspace');
  const origin = 'http://127.0.0.1:' + mcpPort;
  server = spawn(process.execPath, ['dist/index.js'], {
    cwd: root, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, ...config, PORT: String(mcpPort), ADMIN_PORT: String(adminPort), WORKSPACE_PATH: workspace,
      CHECKPOINT_PATH: path.join(fixture, 'checkpoints'), AUDIT_LOG_PATH: path.join(fixture, 'audit.log'), MCP_SHELL_STATE_DIR: path.join(fixture, 'state') },
  });
  let health;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    assert.equal(server.exitCode, null, 'isolated server exited early');
    try { const r = await fetch(origin + '/health'); if (r.ok) { health = await r.json(); break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(health); assert.equal(health.shellGuardMode, 'approval'); assert.equal(health.shellSandboxed, false);
  assert.equal((await fetch('http://127.0.0.1:' + adminPort + '/api/instructions/preview')).status, 401);
  client = new Client({ name: 'clean-setup-smoke', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp/' + config.MCP_TOKEN)));
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 26);
  assert.equal(tools.find(tool => tool.name === 'run_command').annotations.openWorldHint, true);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined); assert.equal(result.structuredContent.ok, true); return result.structuredContent.data;
  };
  await call('create_directory', { path: 'nested' });
  await call('write_file', { path: 'nested/smoke.txt', content: 'first' });
  await call('write_file', { path: 'nested/smoke.txt', content: 'second' });
  assert.equal(await fs.readFile(path.join(workspace, 'nested/smoke.txt'), 'utf8'), 'second');
  await call('delete_file', { path: 'nested/smoke.txt' });
  await assert.rejects(fs.stat(path.join(workspace, 'nested/smoke.txt')), { code: 'ENOENT' });
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0xff]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await call('write_binary_file', { path: 'nested/test.zip', size_bytes: bytes.length, sha256, content_base64: bytes.toString('base64') });
  assert.deepEqual(await fs.readFile(path.join(workspace, 'nested/test.zip')), bytes);
  console.log('PASS clean setup: random tokens, no token output/overwrite, approval default, authenticated isolated MCP, 26 tools, nested create/overwrite/delete, byte-exact binary write.');
} finally {
  if (client) await client.close();
  if (server && server.exitCode == null) { const exited = once(server, 'exit'); server.kill(); await exited; }
  assert.ok(path.basename(fixture).startsWith('guichen-setup with spaces-'));
  await fs.rm(fixture, { recursive: true, force: true });
}
