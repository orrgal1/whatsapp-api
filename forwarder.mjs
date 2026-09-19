import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import nodemailer from 'nodemailer';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

import { createApiServer, ChatStore } from './api.mjs';
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleInfo = console.info.bind(console);
const suppressedSignalWarnings = new Set([
  'Closing open session in favor of incoming prekey bundle',
  'Session already closed',
]);
const suppressedSignalInfo = new Set([
  'Closing session:',
  'Opening session:',
  'Removing old closed session:',
]);
console.warn = (...args) => {
  if (!suppressedSignalWarnings.has(args[0])) originalConsoleWarn(...args);
};
console.info = (...args) => {
  if (!suppressedSignalInfo.has(args[0])) originalConsoleInfo(...args);
};

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const AUTH_DIR = fileURLToPath(new URL('./.whatsapp-auth/', import.meta.url));
const PAIR_ONLY = process.argv.slice(2).includes('--pair-only');
const run = promisify(execFile);
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
const versionPromise = fetchLatestBaileysVersion()
  .then(({ version }) => version)
  .catch(() => null);
const seen = new Set();
let mailQueue = Promise.resolve();
let pairingComplete = false;
const chatStore = new ChatStore();
let currentSock = null;
let apiServer = null;

function readJson(filename) {
  try {
    return JSON.parse(readFileSync(new URL(filename, import.meta.url), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Missing ${filename}. Run \`npm run setup\` first.`);
    }
    throw new Error(`Could not read ${filename}: ${error.message}`);
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

function loadConfig() {
  const value = readJson('./config.json');
  const destination = requireString(value.destination, 'config.destination');
  const delivery = value.delivery;
  if (!delivery || typeof delivery !== 'object') throw new Error('config.delivery must be an object.');

  let deliveryConfig;
  if (delivery.type === 'gapi') {
    deliveryConfig = { type: 'gapi', command: requireString(delivery.command, 'config.delivery.command') };
  } else if (delivery.type === 'smtp') {
    const port = Number(delivery.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('config.delivery.port must be an integer from 1 to 65535.');
    }
    if (typeof delivery.secure !== 'boolean') throw new Error('config.delivery.secure must be a boolean.');
    deliveryConfig = {
      type: 'smtp',
      host: requireString(delivery.host, 'config.delivery.host'),
      port,
      secure: delivery.secure,
      user: requireString(delivery.user, 'config.delivery.user'),
      password: requireString(delivery.password, 'config.delivery.password'),
    };
  } else {
    throw new Error('config.delivery.type must be "gapi" or "smtp".');
  }

  const api = value.api && typeof value.api === 'object' ? {
    enabled: value.api.enabled !== false,
    port: Number(value.api.port) || 8080,
    host: value.api.host || '127.0.0.1',
    token: typeof value.api.token === 'string' ? value.api.token.trim() : '',
  } : {
    enabled: true,
    port: 8080,
    host: '127.0.0.1',
    token: '',
  };

  return { destination, delivery: deliveryConfig, api };
}

function loadExcludedConversations() {
  const value = readJson('./excluded-conversations.json');
  if (!Array.isArray(value.names) || !Array.isArray(value.ids)) {
    throw new Error('excluded-conversations.json must contain names and ids arrays.');
  }
  const normalize = (item) => String(item).trim().toLowerCase();
  return {
    names: new Set(value.names.map(normalize).filter(Boolean)),
    ids: new Set(value.ids.map(normalize).filter(Boolean)),
  };
}

const CONFIG = loadConfig();
const EXCLUDED = loadExcludedConversations();
const smtpTransport = CONFIG.delivery.type === 'smtp'
  ? nodemailer.createTransport({
      host: CONFIG.delivery.host,
      port: CONFIG.delivery.port,
      secure: CONFIG.delivery.secure,
      auth: { user: CONFIG.delivery.user, pass: CONFIG.delivery.password },
    })
  : null;

function isExcludedConversation({ chatId, senderId, sender, chat }) {
  const ids = [chatId, senderId, chatId.replace(/@.*/, ''), senderId.replace(/@.*/, '')]
    .map((value) => value.toLowerCase());
  const names = [sender, chat].map((value) => value.trim().toLowerCase());
  return ids.some((value) => EXCLUDED.ids.has(value))
    || names.some((value) => EXCLUDED.names.has(value));
}

function unwrap(message) {
  let current = message;
  while (current) {
    const type = getContentType(current);
    if (type === 'ephemeralMessage') current = current.ephemeralMessage?.message;
    else if (type === 'viewOnceMessage') current = current.viewOnceMessage?.message;
    else if (type === 'viewOnceMessageV2') current = current.viewOnceMessageV2?.message;
    else if (type === 'viewOnceMessageV2Extension') current = current.viewOnceMessageV2Extension?.message;
    else break;
  }
  return current || {};
}

function describe(message) {
  const content = unwrap(message);
  const type = getContentType(content);
  const value = type ? content[type] : null;

  switch (type) {
    case 'conversation': return { type: 'text', text: content.conversation };
    case 'extendedTextMessage': return { type: 'text', text: value?.text || '' };
    case 'imageMessage': return { type: 'image', text: value?.caption || '[image]' };
    case 'videoMessage': return { type: 'video', text: value?.caption || '[video]' };
    case 'audioMessage': return { type: value?.ptt ? 'voice message' : 'audio', text: value?.ptt ? '[voice message]' : '[audio]' };
    case 'documentMessage': return { type: 'document', text: value?.caption || value?.fileName || '[document]' };
    case 'stickerMessage': return { type: 'sticker', text: '[sticker]' };
    case 'contactMessage': return { type: 'contact', text: `${value?.displayName || '[contact]'}\n${value?.vcard || ''}`.trim() };
    case 'contactsArrayMessage': return { type: 'contacts', text: (value?.contacts || []).map((contact) => contact.displayName || contact.vcard).filter(Boolean).join('\n\n') || '[contacts]' };
    case 'locationMessage': return { type: 'location', text: `${value?.name || value?.address || '[location]'}\nhttps://maps.google.com/?q=${value?.degreesLatitude},${value?.degreesLongitude}` };
    case 'liveLocationMessage': return { type: 'live location', text: `https://maps.google.com/?q=${value?.degreesLatitude},${value?.degreesLongitude}` };
    case 'reactionMessage': return { type: 'reaction', text: value?.text || '[reaction removed]' };
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3': return { type: 'poll', text: [value?.name, ...(value?.options || []).map((option) => `- ${option.optionName}`)].filter(Boolean).join('\n') };
    default: return { type: type || 'unknown', text: `[${type || 'unsupported message'}]` };
  }
}

async function sendMail(subject, body) {
  if (CONFIG.delivery.type === 'gapi') {
    await run(CONFIG.delivery.command, [
      'gmail',
      'send',
      '--to',
      CONFIG.destination,
      '--subject',
      subject,
      '--body',
      body,
    ], { cwd: ROOT, timeout: 120_000, maxBuffer: 1024 * 1024 });
    return;
  }

  await smtpTransport.sendMail({
    from: CONFIG.delivery.user,
    to: CONFIG.destination,
    subject,
    text: body,
  });
}

function enqueueMail(work) {
  mailQueue = mailQueue.then(work, work);
  return mailQueue;
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const version = await versionPromise;
  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    browser: ['WhatsApp Forwarder', 'Chrome', '120.0'],
    getMessage: async () => ({ conversation: '' }),
  });
  currentSock = sock;

  if (!PAIR_ONLY && CONFIG.api?.enabled !== false && !apiServer) {
    apiServer = createApiServer({
      getSocket: () => currentSock,
      token: CONFIG.api.token,
      store: chatStore,
      logger: console,
    });
    try {
      await apiServer.listen(CONFIG.api.port, CONFIG.api.host);
      console.log(`API server listening on http://${CONFIG.api.host}:${CONFIG.api.port} (OpenAPI: /openapi.json, Docs: /docs)`);
    } catch (err) {
      console.error(`Failed to start API server on port ${CONFIG.api.port}:`, err.message);
    }
  }
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nScan this in WhatsApp: Settings → Linked Devices → Link a Device\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      if (PAIR_ONLY) {
        pairingComplete = true;
        try {
          await saveCreds();
          console.log('WhatsApp connected. Pairing is complete.');
          setTimeout(() => process.exit(0), 750);
        } catch (error) {
          console.error(`Could not save WhatsApp credentials: ${error.message}`);
          process.exit(1);
        }
      } else {
        console.log(`Connected. Forwarding incoming WhatsApp messages to ${CONFIG.destination}.`);
      }
    }
    if (connection === 'close' && !pairingComplete) {
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status === DisconnectReason.loggedOut) {
        console.error('WhatsApp logged out. Remove .whatsapp-auth and run setup again to re-pair.');
        process.exitCode = 1;
      } else {
        console.warn('WhatsApp disconnected; reconnecting…', lastDisconnect?.error?.message || lastDisconnect?.error || `status ${status}`);
        setTimeout(connect, 2000);
      }
    }
  });

  if (PAIR_ONLY) return;

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const id = msg.key.id;
      const chatId = msg.key.remoteJid || '';
      if (!id || chatId === 'status@broadcast' || chatId.endsWith('@newsletter')) continue;

      const senderId = msg.key.participant || chatId;
      const sender = msg.pushName || senderId.replace(/@.*/, '');
      const isGroup = chatId.endsWith('@g.us');
      let chat = isGroup ? chatId.replace(/@.*/, '') : sender;
      if (isGroup) {
        try { chat = (await sock.groupMetadata(chatId)).subject || chat; } catch {}
      }

      const details = describe(msg.message);
      const timestamp = new Date(Number(msg.messageTimestamp || Date.now() / 1000) * 1000);

      chatStore.recordMessage({
        id,
        chatId,
        senderId,
        senderName: msg.key.fromMe ? 'Me' : sender,
        fromMe: Boolean(msg.key.fromMe),
        timestamp: timestamp.getTime(),
        type: details.type,
        text: details.text,
        rawMessage: msg.message,
      });
      chatStore.setChatMetadata(chatId, { name: chat, isGroup });

      if (seen.has(id) || msg.key.fromMe || !msg.message) continue;
      seen.add(id);
      if (seen.size > 5000) seen.delete(seen.values().next().value);

      if (isExcludedConversation({ chatId, senderId, sender, chat })) {
        console.log(`Skipped excluded conversation ${chat}.`);
        continue;
      }
      const subject = `WhatsApp from ${sender}${isGroup ? ` in ${chat}` : ''}`;
      const body = [
        `From: ${sender} (${senderId})`,
        `Chat: ${chat}${isGroup ? ' (group)' : ''}`,
        `Received: ${timestamp.toLocaleString()}`,
        `Type: ${details.type}`,
        '',
        details.text,
      ].join('\n');

      enqueueMail(async () => {
        try {
          await sendMail(subject, body);
          console.log(`Forwarded ${details.type} from ${sender} through ${CONFIG.delivery.type}.`);
        } catch (error) {
          console.error(`Failed to forward message ${id}:`, error.message);
        }
      });
    }
  });
}

connect().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
