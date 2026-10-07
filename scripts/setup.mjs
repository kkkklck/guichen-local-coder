import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, '.env');
await fs.mkdir(path.join(root, 'workspace'), { recursive: true });
const example = await fs.readFile(path.join(root, '.env.example'), 'utf8');
const config = example
  .replace(/^MCP_TOKEN=$/m, 'MCP_TOKEN=' + randomBytes(32).toString('base64url'))
  .replace(/^ADMIN_TOKEN=$/m, 'ADMIN_TOKEN=' + randomBytes(32).toString('base64url'));
try {
  await fs.writeFile(configPath, config, { flag: 'wx', mode: 0o600 });
  console.log('Created local .env with random tokens and ./workspace. Default Shell mode: approval.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing .env retained. Edit it locally if configuration changes are needed.');
}
