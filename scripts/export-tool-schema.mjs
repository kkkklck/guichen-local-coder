import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/server-factory.js';
import { setDefaultCwd } from '../dist/lib/path-security.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'guichen-schema-'));
setDefaultCwd(fixture);
process.env.SHELL_GUARD_MODE = 'approval';
process.env.CHATGPT_TOOL_PROFILE = 'slim';
process.env.MCP_SHELL_STATE_DIR = path.join(fixture, 'state');
const server = createMcpServer(fixture, 120);
const client = new Client({ name: 'schema-export', version: '1' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.listTools();
  await fs.writeFile(path.join(root, 'docs', 'tools.schema.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`Exported tools/list: ${result.tools.length} tools, approval mode, no command executed.`);
} finally {
  await client.close();
  await server.close();
  if (!path.basename(fixture).startsWith('guichen-schema-')) throw new Error('Invalid cleanup path');
  await fs.rm(fixture, { recursive: true, force: true });
}
