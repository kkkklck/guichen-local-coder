import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// This test uses a local fake control plane, dummy credentials and an invalid
// public DNS name. It never connects to the production tunnel or executes code.
const executable = fileURLToPath(new URL('../tunnel-client.exe', import.meta.url));
const mcp = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(404).end(); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  let message;
  try { message = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
  if (message.id == null) { res.writeHead(202).end(); return; }
  const result = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-test', version: '1' } }
    : { tools: [] };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
let requests = 0;
const proxy = http.createServer(async (req, res) => {
  if (req.url.startsWith('http://controlplane.invalid/')) requests++;
  await delay(100);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"commands":[]}');
});
await Promise.all([new Promise(resolve => mcp.listen(0, '127.0.0.1', resolve)), new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))]);
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

async function probe(explicit) {
  requests = 0;
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(CONTROL_PLANE_|TUNNEL_CLIENT_|MCP_|HARPOON_|CLOUDFLARED_|HEALTH_|LOG_|PID_)/i.test(name)) delete env[name];
  Object.assign(env, {
    CONTROL_PLANE_API_KEY: 'dummy-test-credential',
    CONTROL_PLANE_TUNNEL_ID: 'tunnel_00000000000000000000000000000001',
    CONTROL_PLANE_BASE_URL: 'http://controlplane.invalid',
    MCP_SERVER_URL: `http://127.0.0.1:${mcp.address().port}/mcp`,
    HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: 'localhost,127.0.0.1,::1',
  });
  const args = ['run', '--health.listen-addr', '127.0.0.1:0', '--control-plane.poll-timeout', '1s'];
  if (explicit) args.push('--control-plane.http-proxy', 'env:HTTPS_PROXY');
  const child = spawn(executable, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', c => { output = (output + c).slice(-8000); }); child.stderr.on('data', c => { output = (output + c).slice(-8000); });
  const exited = once(child, 'exit');
  try {
    for (let i = 0; i < 40; i++) { await delay(100); if (requests > 0 || child.exitCode != null) break; }
    return { explicit, proxyRequests: requests, exitedEarly: child.exitCode != null, transportErrorObserved: output.includes('network_error') };
  } finally {
    if (child.exitCode == null) child.kill();
    await exited;
  }
}
try {
  const standard = await probe(false);
  const explicit = await probe(true);
  console.log(JSON.stringify({ standard, explicit }, null, 2));
  assert.equal(explicit.exitedEarly, false);
  assert.ok(explicit.proxyRequests > 0, 'explicit control-plane proxy must receive the request');
  console.log('PASS: explicit control-plane proxy routing verified with local dummy credentials.');
} finally { mcp.close(); proxy.close(); }
