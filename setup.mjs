import { spawn } from 'node:child_process';
import { constants as fsConstants, accessSync, readFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { installService } from './service.mjs';

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL('./config.json', import.meta.url));
const EXCLUDED_PATH = fileURLToPath(new URL('./excluded-conversations.json', import.meta.url));
const CREDS_PATH = fileURLToPath(new URL('./.whatsapp-auth/creds.json', import.meta.url));
const FORWARDER_PATH = fileURLToPath(new URL('./forwarder.mjs', import.meta.url));

class PromptOutput extends Writable {
  muted = false;

  _write(chunk, encoding, callback) {
    if (!this.muted) process.stdout.write(chunk, encoding);
    callback();
  }
}

function readExisting(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Could not read ${path}: ${error.message}`);
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

function commaSeparated(value) {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function displayList(values) {
  return Array.isArray(values) ? values.join(', ') : '';
}

function resolveExecutable(command) {
  if (command.includes(path.sep)) return command;
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return command;
}
function requireExecutable(command) {
  const resolved = resolveExecutable(command);
  try {
    accessSync(resolved, fsConstants.X_OK);
    return resolved;
  } catch {
    throw new Error(`gapi executable not found or not executable: ${command}`);
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
    const child = spawn(process.execPath, [FORWARDER_PATH, '--pair-only'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`WhatsApp pairing failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`));
    });
  });
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('Setup currently supports macOS only.');

  const currentConfig = readExisting(CONFIG_PATH, {});
  const currentExcluded = readExisting(EXCLUDED_PATH, { names: [], ids: [] });
  const output = new PromptOutput();
  const prompts = createInterface({ input: process.stdin, output, terminal: true });

  const ask = async (label, defaultValue = '') => {
    const suffix = defaultValue === '' ? '' : ` [${defaultValue}]`;
    const answer = (await prompts.question(`${label}${suffix}: `)).trim();
    return answer || String(defaultValue).trim();
  };
  const askRequired = async (label, defaultValue = '') => {
    while (true) {
      const answer = await ask(label, defaultValue);
      if (answer) return answer;
      console.log('A value is required.');
    }
  };
  const askChoice = async (label, choices, defaultValue) => {
    while (true) {
      const answer = (await ask(`${label} (${choices.join('/')})`, defaultValue)).toLowerCase();
      if (choices.includes(answer)) return answer;
      console.log(`Choose ${choices.join(' or ')}.`);
    }
  };
  const askBoolean = async (label, defaultValue) => {
    const defaultText = defaultValue ? 'y' : 'n';
    while (true) {
      const answer = (await ask(`${label} (y/n)`, defaultText)).toLowerCase();
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      console.log('Enter y or n.');
    }
  };
  const askSecret = async (label, keepExisting) => {
    const suffix = keepExisting ? ' (leave blank to keep existing)' : '';
    process.stdout.write(`${label}${suffix}: `);
    output.muted = true;
    const answer = (await prompts.question('')).trim();
    output.muted = false;
    process.stdout.write('\n');
    return answer;
  };

  console.log('WhatsApp Email Forwarder setup\n');
  try {
    const destination = await askRequired('Destination email address', currentConfig.destination || '');
    const existingType = currentConfig.delivery?.type === 'smtp' ? 'smtp' : 'gapi';
    const deliveryType = await askChoice('Delivery method', ['gapi', 'smtp'], existingType);
    let delivery;

    if (deliveryType === 'gapi') {
      const existingCommand = currentConfig.delivery?.type === 'gapi' ? currentConfig.delivery.command : '';
      const suggestedCommand = resolveExecutable(existingCommand || 'gapi');
      const command = requireExecutable(await askRequired('gapi executable path or command', suggestedCommand));
      delivery = { type: 'gapi', command };
    } else {
      const existing = currentConfig.delivery?.type === 'smtp' ? currentConfig.delivery : {};
      const host = await askRequired('SMTP host', existing.host || '');
      let port;
      while (!port) {
        const candidate = Number(await askRequired('SMTP port', existing.port || 587));
        if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) port = candidate;
        else console.log('Enter a port from 1 to 65535.');
      }
      const secure = await askBoolean('Use implicit TLS', existing.secure ?? port === 465);
      const user = await askRequired('SMTP username', existing.user || '');
      let password = await askSecret('SMTP password', Boolean(existing.password));
      if (!password) password = existing.password || '';
      while (!password) {
        console.log('A password is required.');
        password = await askSecret('SMTP password', false);
      }
      delivery = { type: 'smtp', host, port, secure, user, password };
    }

    const names = commaSeparated(await ask(
      'Excluded conversation names (comma-separated, exact matches)',
      displayList(currentExcluded.names),
    ));
    const ids = commaSeparated(await ask(
      'Excluded conversation IDs (comma-separated, exact matches)',
      displayList(currentExcluded.ids),
    ));

    await writePrivateJson(CONFIG_PATH, { destination, delivery });
    await writePrivateJson(EXCLUDED_PATH, { names, ids });
  } finally {
    prompts.close();
    output.muted = false;
  }

  console.log('\nConfiguration saved.');
  if (hasCredentials()) {
    console.log('Existing WhatsApp credentials found; pairing skipped.');
  } else {
    console.log('No WhatsApp credentials found. Starting device pairing…');
    await runPairing();
  }

  await installService();
  console.log('\nSetup complete.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
