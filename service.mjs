import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE_LABEL = 'com.local.whatsapp-email-forwarder';
export const LEGACY_SERVICE_LABEL = 'com.orgal.whatsapp-forwarder';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
export const SERVICE_PLIST_PATH = path.join(
  LAUNCH_AGENTS_DIR,
  `${SERVICE_LABEL}.plist`,
);
export const LEGACY_PLIST_PATH = path.join(
  LAUNCH_AGENTS_DIR,
  `${LEGACY_SERVICE_LABEL}.plist`,
);
const LOG_PATH = path.join(APP_ROOT, 'forwarder.log');
const FORWARDER_PATH = path.join(APP_ROOT, 'forwarder.mjs');
const DOMAIN = `gui/${process.getuid()}`;
const LAUNCHCTL = '/bin/launchctl';

class LaunchctlError extends Error {
  constructor(args, code, stdout, stderr) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
    super(`launchctl ${args.join(' ')} failed: ${detail}`);
    this.name = 'LaunchctlError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function runLaunchctl(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(LAUNCHCTL, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new LaunchctlError(args, code, stdout, stderr));
      }
    });
  });
}

function isMissingServiceError(error) {
  if (!(error instanceof LaunchctlError)) return false;
  const output = `${error.stdout}\n${error.stderr}`;
  return (
    error.code === 113 ||
    /could not find service|service not found|no such process/i.test(output)
  );
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function isServiceLoaded(label) {
  try {
    const result = await runLaunchctl(['print', `${DOMAIN}/${label}`]);
    return { loaded: true, details: result.stdout.trim() };
  } catch (error) {
    if (isMissingServiceError(error)) return { loaded: false, details: '' };
    throw error;
  }
}

async function unloadService(label, plistPath) {
  const target = (await pathExists(plistPath))
    ? [DOMAIN, plistPath]
    : [`${DOMAIN}/${label}`];

  try {
    await runLaunchctl(['bootout', ...target]);
  } catch (error) {
    const status = await isServiceLoaded(label);
    if (status.loaded) throw error;
    return false;
  }

  const status = await isServiceLoaded(label);
  if (status.loaded) {
    throw new Error(`Service ${label} is still loaded after launchctl bootout.`);
  }
  return true;
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function createPlist() {
  const string = (value) => `    <string>${xmlEscape(value)}</string>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
${string(SERVICE_LABEL)}
  <key>ProgramArguments</key>
  <array>
${string(process.execPath)}
${string(FORWARDER_PATH)}
  </array>
  <key>WorkingDirectory</key>
${string(APP_ROOT)}
  <key>StandardOutPath</key>
${string(LOG_PATH)}
  <key>StandardErrorPath</key>
${string(LOG_PATH)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

async function removePlist(plistPath) {
  try {
    await fs.unlink(plistPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function writePlistAtomically(contents) {
  const temporaryPath = `${SERVICE_PLIST_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents, {
      encoding: 'utf8',
      mode: 0o644,
      flag: 'wx',
    });
    await fs.rename(temporaryPath, SERVICE_PLIST_PATH);
  } finally {
    await removePlist(temporaryPath);
  }
}

export async function installService() {
  await fs.mkdir(LAUNCH_AGENTS_DIR, { recursive: true });

  await unloadService(LEGACY_SERVICE_LABEL, LEGACY_PLIST_PATH);
  await removePlist(LEGACY_PLIST_PATH);

  await unloadService(SERVICE_LABEL, SERVICE_PLIST_PATH);
  await removePlist(SERVICE_PLIST_PATH);
  await writePlistAtomically(createPlist());

  await runLaunchctl(['bootstrap', DOMAIN, SERVICE_PLIST_PATH]);
  const status = await isServiceLoaded(SERVICE_LABEL);
  if (!status.loaded) {
    throw new Error(`Service ${SERVICE_LABEL} was not loaded after installation.`);
  }

  console.log(`Installed and started ${SERVICE_LABEL}.`);
  console.log(`LaunchAgent: ${SERVICE_PLIST_PATH}`);
  console.log(`Log: ${LOG_PATH}`);
}

export async function serviceStatus() {
  const status = await isServiceLoaded(SERVICE_LABEL);
  if (!status.loaded) {
    console.log(`${SERVICE_LABEL} is not loaded.`);
    console.log(`Expected LaunchAgent: ${SERVICE_PLIST_PATH}`);
    return false;
  }

  console.log(`${SERVICE_LABEL} is loaded.`);
  if (status.details) console.log(status.details);
  return true;
}

export async function uninstallService() {
  const unloaded = await unloadService(SERVICE_LABEL, SERVICE_PLIST_PATH);
  await removePlist(SERVICE_PLIST_PATH);

  console.log(
    unloaded
      ? `Stopped and uninstalled ${SERVICE_LABEL}.`
      : `${SERVICE_LABEL} was not loaded; its LaunchAgent has been removed.`,
  );
}

async function main() {
  const [command, ...extraArguments] = process.argv.slice(2);
  if (extraArguments.length > 0 || !['install', 'status', 'uninstall'].includes(command)) {
    console.error('Usage: node service.mjs install|status|uninstall');
    process.exitCode = 1;
    return;
  }

  if (command === 'install') {
    await installService();
  } else if (command === 'status') {
    if (!(await serviceStatus())) process.exitCode = 1;
  } else {
    await uninstallService();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
