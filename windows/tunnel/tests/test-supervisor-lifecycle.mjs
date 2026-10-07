import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';

// An isolated copy of the production supervisor, a dummy local child, and
// synthetic network/local-server readiness. No real credential, production
// endpoint, Windows proxy setting, or running bridge process is touched.
const testRoot = path.dirname(fileURLToPath(import.meta.url));
const dir = await fs.mkdtemp(path.join(testRoot, '.lifecycle-'));
// The fake executable is CommonJS. Do not inherit the main repo's ESM mode.
await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
const bridgeRoot = path.dirname(testRoot);
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const reserve = http.createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
let state = { local: false, network: false, stop: false, crash: false };
const statePath = path.join(dir, 'state.json');
async function update(change) {
  state = { ...state, ...change };
  await fs.writeFile(statePath + '.tmp', JSON.stringify(state));
  await fs.rename(statePath + '.tmp', statePath);
}
await update({});
let source = await fs.readFile(path.join(bridgeRoot, 'start-tunnel-autostart.ps1'), 'utf8');
// Accelerate monitoring intervals only. Keep actual retry/backoff logic.
source = source.replaceAll('Local\\GuichenLocalCoder.Tunnel.', 'Local\\GuichenLocalCoder.LifecycleTest.' + path.basename(dir) + '.')
  .replaceAll('LocalPort 8080', 'LocalPort ' + port)
  .replaceAll('.AddSeconds(15)', '.AddMilliseconds(250)')
  .replaceAll('.AddSeconds(3)', '.AddMilliseconds(200)');
await fs.writeFile(path.join(dir, 'supervisor.ps1'), '\uFEFF' + source);
const module = `. ${quote(path.join(bridgeRoot, 'bridge-runtime.ps1'))}
$script:BridgeBinary = ${quote(process.execPath)}
$script:BridgeLogDir = ${quote(dir)}
$env:BRIDGE_TEST_DIRECTORY = ${quote(dir)}
$env:BRIDGE_TEST_PORT = '${port}'
function Get-TestState { Get-Content -LiteralPath ${quote(statePath)} -Raw | ConvertFrom-Json }
function Get-BridgeConfiguration { [pscustomobject]@{TunnelId='tunnel_00000000000000000000000000000001';McpToken='dummy-mcp-token'} }
function Get-BridgeRuntimeKey { return 'dummy-test-credential' }
function Get-BridgeProxyRoute {
 $state = Get-TestState
 if ($state.stop) { throw 'TEST_COMPLETE' }
 [pscustomobject]@{Kind='test_route';Uri=$null;Identity='test_route'}
}
function Test-BridgeNetworkRoute($route) { return (Get-TestState).network }
function Test-BridgeLocalServer { return (Get-TestState).local }
function Get-BridgeTunnelSnapshot {
 try { Invoke-RestMethod 'http://127.0.0.1:${port}/health' -TimeoutSec 1 } catch { return $null }
}
`;
await fs.writeFile(path.join(dir, 'bridge-runtime.ps1'), module);
await fs.writeFile(path.join(dir, 'run'), `
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const dir=process.env.BRIDGE_TEST_DIRECTORY;
const counter=path.join(dir,'launches.txt');
let launches=0;try{launches=Number(fs.readFileSync(counter,'utf8'))}catch{}
fs.writeFileSync(counter,String(launches+1));
const snapshot={live:true,ready:true,components:{'control-plane':{status:'ok',state:'polling',observed_at:new Date().toISOString(),details:{last_success:new Date().toISOString(),consecutive_failures:0}},dispatcher:{details:{active:0}},queue:{details:{depth:0}},'response-delivery':{details:{in_progress:0}}}};
const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(snapshot))});
server.listen(Number(process.env.BRIDGE_TEST_PORT),'127.0.0.1');
console.log(JSON.stringify({level:'WARN',msg:'test diagnostic',error:'credential='+process.env.CONTROL_PLANE_API_KEY}));
setInterval(()=>{const state=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));if(state.crash&&!fs.existsSync(path.join(dir,'crashed'))){fs.writeFileSync(path.join(dir,'crashed'),'1');process.exit(17)}},100);
`);
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const worker = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'supervisor.ps1')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
worker.stdout.on('data', c => { output += c; }); worker.stderr.on('data', c => { output += c; });
const exited = once(worker, 'exit');
async function readStatus() { try { return JSON.parse((await fs.readFile(path.join(dir, 'bridge-status.json'), 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; } }
async function launches() { try { return Number(await fs.readFile(path.join(dir, 'launches.txt'), 'utf8')); } catch { return 0; } }
async function until(predicate, name, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (worker.exitCode != null) throw new Error('Fixture exited early during ' + name + ': ' + output.slice(-1500));
    if (await predicate()) return;
    await delay(100);
  }
  const status = await readStatus();
  let log = '';
  try { log = await fs.readFile(path.join(dir, 'tunnel-autostart.log'), 'utf8'); } catch {}
  throw new Error('Timed out: ' + name + '; state=' + status?.state + '; launches=' + await launches() + '\n' + log.slice(-2000));
}
try {
  await until(async () => (await readStatus())?.state === 'waiting_local_server', 'local server startup wait');
  assert.equal(await launches(), 0);
  await update({ local: true });
  await until(async () => (await readStatus())?.state === 'waiting_network', 'late system proxy wait');
  assert.equal(await launches(), 0, 'no child starts before the network route is ready');
  await update({ network: true });
  await until(async () => (await readStatus())?.state === 'connected', 'connection after proxy readiness');
  assert.equal(await launches(), 1);
  await update({ crash: true });
  await until(async () => (await launches()) === 2 && (await readStatus())?.state === 'connected', 'bounded restart after native exit', 20000);
  const logs = await fs.readFile(path.join(dir, 'tunnel-autostart.log'), 'utf8');
  assert.ok(logs.includes('code=17'));
  assert.ok(!logs.includes('dummy-test-credential'), 'native diagnostics redact the credential before persistence');
  console.log('PASS: delayed local server, delayed proxy, successful polling status, native exit/restart, and credential redaction.');
} finally {
  await update({ stop: true });
  await Promise.race([exited, delay(5000)]);
  if (worker.exitCode == null) { worker.kill(); await exited; }
  // Each fixture owns only its temp directory; refuse broader recursive removal.
  const resolved = path.resolve(dir);
  assert.ok(resolved.startsWith(path.resolve(testRoot) + path.sep));
  await fs.rm(resolved, { recursive: true, force: true });
}
