import { spawn } from 'node:child_process';
import { constants as fsConstants, accessSync, readFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { installService } from './service.mjs';

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL('./config.json', import.meta.url));
const CREDS_PATH = fileURLToPath(new URL('./.whatsapp-auth/creds.json', import.meta.url));
const SERVER_PATH = fileURLToPath(new URL('./server.mjs', import.meta.url));

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writePrivateJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function hasCredentials() {
  try {
    accessSync(CREDS_PATH, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function runPairing() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH, '--pair-only'], { cwd: ROOT, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`WhatsApp pairing failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`));
    });
  });
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('Setup currently supports macOS only.');
  const config = readConfig();
  const prompts = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let port;
  try {
    while (!port) {
      const answer = (await prompts.question(`HTTP API port [${config.api?.port || 8080}]: `)).trim();
      const candidate = Number(answer || config.api?.port || 8080);
      if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) port = candidate;
      else console.log('Enter a port from 1 to 65535.');
    }
  } finally {
    prompts.close();
  }
  await writePrivateJson(CONFIG_PATH, { api: { enabled: true, port, host: '127.0.0.1' } });
  if (hasCredentials()) console.log('Existing WhatsApp pairing found.');
  else await runPairing();
  await installService();
  console.log('WhatsApp API setup complete.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
