import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const MAX_MESSAGES_PER_CHAT = 100;
const MAX_CHATS = 500;

export class ChatStore {
  constructor() {
    this.chats = new Map(); // chatId -> { id, name, isGroup, unreadCount, updatedAt, lastMessage }
    this.messages = new Map(); // chatId -> Array of message objects
  }

  recordMessage({ id, chatId, senderId, senderName, fromMe, timestamp, type, text, rawMessage }) {
    if (!chatId) return;

    if (!this.messages.has(chatId)) {
      this.messages.set(chatId, []);
    }
    const chatMessages = this.messages.get(chatId);
    const msgObj = {
      id,
      chatId,
      senderId: senderId || chatId,
      senderName: senderName || '',
      fromMe: Boolean(fromMe),
      timestamp: timestamp || Date.now(),
      type: type || 'text',
      text: text || '',
      rawMessage: rawMessage || null,
    };

    // Avoid duplicates
    const existingIndex = chatMessages.findIndex((m) => m.id === id);
    if (existingIndex >= 0) {
      chatMessages[existingIndex] = msgObj;
    } else {
      chatMessages.push(msgObj);
      if (chatMessages.length > MAX_MESSAGES_PER_CHAT) {
        chatMessages.shift();
      }
    }

    const isGroup = chatId.endsWith('@g.us');
    const existingChat = this.chats.get(chatId) || {
      id: chatId,
      name: isGroup ? chatId.replace(/@.*/, '') : (senderName || chatId.replace(/@.*/, '')),
      isGroup,
      unreadCount: 0,
    };

    if (!fromMe) {
      existingChat.unreadCount = (existingChat.unreadCount || 0) + 1;
    }
    if (senderName && !isGroup) {
      existingChat.name = senderName;
    }
    existingChat.lastMessage = {
      id,
      text: text || `[${type}]`,
      timestamp: msgObj.timestamp,
      fromMe: msgObj.fromMe,
    };
    existingChat.updatedAt = msgObj.timestamp;

    this.chats.set(chatId, existingChat);

    if (this.chats.size > MAX_CHATS) {
      const oldestChatKey = this.chats.keys().next().value;
      this.chats.delete(oldestChatKey);
      this.messages.delete(oldestChatKey);
    }
  }

  setChatMetadata(chatId, { name, isGroup }) {
    if (!chatId) return;
    const existing = this.chats.get(chatId) || {
      id: chatId,
      name: name || chatId.replace(/@.*/, ''),
      isGroup: Boolean(isGroup),
      unreadCount: 0,
      updatedAt: Date.now(),
    };
    if (name) existing.name = name;
    if (typeof isGroup === 'boolean') existing.isGroup = isGroup;
    this.chats.set(chatId, existing);
  }

  markRead(chatId) {
    const chat = this.chats.get(chatId);
    if (chat) chat.unreadCount = 0;
  }

  getChats() {
    return Array.from(this.chats.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  getMessages(chatId, limit = 50) {
    const msgs = this.messages.get(chatId) || [];
    const count = Math.min(Math.max(Number(limit) || 20, 1), MAX_MESSAGES_PER_CHAT);
    return msgs.slice(-count);
  }

  getMessage(chatId, messageId) {
    const msgs = this.messages.get(chatId) || [];
    return msgs.find((m) => m.id === messageId);
  }
}

export function normalizeJid(target) {
  if (!target || typeof target !== 'string') return '';
  const trimmed = target.trim();
  if (trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@g.us') || trimmed.endsWith('@lid')) {
    return trimmed;
  }
  const digitsOnly = trimmed.replace(/[^0-9]/g, '');
  if (!digitsOnly) return '';
  return `${digitsOnly}@s.whatsapp.net`;
}

export function generateOpenApiSpec(serverUrl = '') {
  return {
    openapi: '3.1.0',
    info: {
      title: 'WhatsApp Chat API',
      version: '1.0.0',
      description: 'Persistent local WhatsApp Web API wrapper for remote agents to interact with chats, messages, and reactions.',
    },
    servers: serverUrl ? [{ url: serverUrl }] : [],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT or Token',
          description: 'Bearer token configured in config.json',
        },
      },
      schemas: {
        HealthResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            connected: { type: 'boolean', example: true },
            phone: { type: 'string', example: '1234567890' },
            uptimeSeconds: { type: 'number', example: 120 },
            chatsCount: { type: 'number', example: 12 },
          },
          required: ['status', 'connected', 'phone', 'uptimeSeconds'],
        },
        ChatSummary: {
          type: 'object',
          properties: {
            id: { type: 'string', example: '1234567890@s.whatsapp.net' },
            name: { type: 'string', example: 'Alice' },
            isGroup: { type: 'boolean', example: false },
            unreadCount: { type: 'number', example: 0 },
            updatedAt: { type: 'number', example: 1726750000000 },
            lastMessage: {
              type: 'object',
              properties: {
                id: { type: 'string', example: '3EB0...' },
                text: { type: 'string', example: 'See you tomorrow!' },
                timestamp: { type: 'number', example: 1726750000000 },
                fromMe: { type: 'boolean', example: false },
              },
            },
          },
          required: ['id', 'name', 'isGroup', 'unreadCount'],
        },
        ChatMessage: {
          type: 'object',
          properties: {
            id: { type: 'string', example: '3EB0...' },
            chatId: { type: 'string', example: '1234567890@s.whatsapp.net' },
            senderId: { type: 'string', example: '1234567890@s.whatsapp.net' },
            senderName: { type: 'string', example: 'Alice' },
            fromMe: { type: 'boolean', example: false },
            timestamp: { type: 'number', example: 1726750000000 },
            type: { type: 'string', example: 'text' },
            text: { type: 'string', example: 'Hello world' },
          },
          required: ['id', 'chatId', 'fromMe', 'timestamp', 'type', 'text'],
        },
        SendMessageRequest: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Phone number with country code (e.g. "+1234567890") or WhatsApp JID', example: '+1234567890' },
            text: { type: 'string', description: 'Message text body', example: 'Hello from remote agent!' },
            mediaUrl: { type: 'string', description: 'Optional media URL to send as image/document/audio/video' },
            mediaType: { type: 'string', enum: ['image', 'document', 'audio', 'video'], default: 'image' },
            fileName: { type: 'string', description: 'File name when sending documents' },
            caption: { type: 'string', description: 'Caption for media' },
          },
          required: ['to'],
        },
        ReplyMessageRequest: {
          type: 'object',
          properties: {
            chatId: { type: 'string', description: 'Target chat JID', example: '1234567890@s.whatsapp.net' },
            text: { type: 'string', description: 'Reply text', example: 'I got your message!' },
            quotedMessageId: { type: 'string', description: 'Message ID being replied to', example: '3EB012345678' },
            quotedParticipant: { type: 'string', description: 'Sender participant JID if group chat' },
          },
          required: ['chatId', 'text', 'quotedMessageId'],
        },
        ReactMessageRequest: {
          type: 'object',
          properties: {
            chatId: { type: 'string', description: 'Chat JID', example: '1234567890@s.whatsapp.net' },
            messageId: { type: 'string', description: 'Target message ID', example: '3EB012345678' },
            emoji: { type: 'string', description: 'Emoji reaction (e.g. "👍", "❤️", "😂") or empty string "" to remove reaction', example: '👍' },
          },
          required: ['chatId', 'messageId', 'emoji'],
        },
        PresenceRequest: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['composing', 'recording', 'paused'], example: 'composing' },
          },
          required: ['action'],
        },
        ActionSuccessResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'sent' },
            messageId: { type: 'string', example: '3EB0...' },
            chatId: { type: 'string', example: '1234567890@s.whatsapp.net' },
          },
          required: ['status'],
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Unauthorized' },
          },
          required: ['error'],
        },
      },
    },
    paths: {
      '/openapi.json': {
        get: {
          summary: 'OpenAPI specification',
          description: 'Returns the OpenAPI 3.1.0 JSON specification for external agent discovery.',
          responses: {
            200: {
              description: 'OpenAPI JSON schema',
              content: { 'application/json': {} },
            },
          },
        },
      },
      '/docs': {
        get: {
          summary: 'Interactive Swagger UI',
          description: 'Returns Swagger UI HTML page for interactive API testing.',
          responses: {
            200: {
              description: 'HTML page',
              content: { 'text/html': {} },
            },
          },
        },
      },
      '/health': {
        get: {
          summary: 'Health & Connection Status',
          description: 'Returns WhatsApp connection state, linked phone number, and service uptime.',
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'Service status',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HealthResponse' },
                },
              },
            },
            401: {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/chats': {
        get: {
          summary: 'List Recent Chats',
          description: 'Returns a list of recent chats with unread counts and last message details.',
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'List of chats',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      chats: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/ChatSummary' },
                      },
                    },
                    required: ['chats'],
                  },
                },
              },
            },
            401: {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/chats/{chatId}/messages': {
        get: {
          summary: 'Get Chat Message History',
          description: 'Retrieve recent messages for a specific chat to provide context for replies.',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'chatId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'WhatsApp Chat JID (e.g. 1234567890@s.whatsapp.net or group JID)',
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', default: 20 },
              description: 'Number of recent messages to fetch (max 100)',
            },
          ],
          responses: {
            200: {
              description: 'List of messages',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      chatId: { type: 'string' },
                      messages: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/ChatMessage' },
                      },
                    },
                    required: ['chatId', 'messages'],
                  },
                },
              },
            },
            401: {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/chats/{chatId}/presence': {
        post: {
          summary: 'Send Chat Presence',
          description: 'Updates typing or recording indicator in a chat.',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'chatId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'WhatsApp Chat JID',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PresenceRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Presence updated',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { status: { type: 'string', example: 'ok' } },
                  },
                },
              },
            },
            401: {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/chats/{chatId}/read': {
        post: {
          summary: 'Mark Chat as Read',
          description: 'Marks incoming messages in the chat as read.',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'chatId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'WhatsApp Chat JID',
            },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    messageId: { type: 'string', description: 'Optional specific message ID to mark read' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Chat marked as read',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { status: { type: 'string', example: 'ok' } },
                  },
                },
              },
            },
            401: {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/messages/send': {
        post: {
          summary: 'Send WhatsApp Message',
          description: 'Sends a new text or media message to a recipient phone number or group JID.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SendMessageRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Message sent successfully',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ActionSuccessResponse' },
                },
              },
            },
            400: {
              description: 'Invalid request body or recipient',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            401: {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            503: {
              description: 'WhatsApp client not connected',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/messages/reply': {
        post: {
          summary: 'Reply to a Message',
          description: 'Replies directly to an existing WhatsApp message in a chat, quoting the original message.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ReplyMessageRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Reply sent successfully',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ActionSuccessResponse' },
                },
              },
            },
            400: {
              description: 'Invalid request body or message parameters',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            401: {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            503: {
              description: 'WhatsApp client not connected',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/messages/react': {
        post: {
          summary: 'React to a Message',
          description: 'Adds an emoji reaction to a message or removes an existing reaction.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ReactMessageRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Reaction sent successfully',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ActionSuccessResponse' },
                },
              },
            },
            400: {
              description: 'Invalid request body',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            401: {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            503: {
              description: 'WhatsApp client not connected',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
    },
  };
}

function renderSwaggerUiHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp Chat API - Swagger UI</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; padding: 0; background: #fafafa; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIBundle.SwaggerUIStandalonePreset
        ],
        layout: "BaseLayout"
      });
    };
  </script>
</body>
</html>`;
}

function parseJsonBody(req, limitBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Payload Too Large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function timingSafeMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createApiServer({
  getSocket,
  token,
  store = new ChatStore(),
  startTime = Date.now(),
  logger = console,
}) {
  const openApiSpec = generateOpenApiSpec();

  function verifyAuth(req) {
    if (!token) return true; // if no token is configured, allow local access
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const provided = match[1].trim();
    return timingSafeMatch(provided, token);
  }

  function sendJson(res, statusCode, data) {
    const payload = JSON.stringify(data, null, 2);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function sendError(res, statusCode, message) {
    sendJson(res, statusCode, { error: message });
  }

  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      // Public routes
      if (pathname === '/openapi.json' && req.method === 'GET') {
        sendJson(res, 200, openApiSpec);
        return;
      }
      if (pathname === '/docs' && req.method === 'GET') {
        const html = renderSwaggerUiHtml();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
        });
        res.end(html);
        return;
      }

      // Check Bearer token for all other endpoints
      if (!verifyAuth(req)) {
        sendError(res, 401, 'Unauthorized: Invalid or missing Bearer token');
        return;
      }

      // Health endpoint
      if (pathname === '/health' && req.method === 'GET') {
        const sock = getSocket ? getSocket() : null;
        const user = sock?.user;
        const connected = Boolean(user && user.id);
        const phone = user?.id ? user.id.replace(/@.*/, '').replace(/:.*/, '') : '';
        const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

        sendJson(res, 200, {
          status: 'ok',
          connected,
          phone,
          uptimeSeconds,
          chatsCount: store.getChats().length,
        });
        return;
      }

      // Chats list
      if (pathname === '/chats' && req.method === 'GET') {
        sendJson(res, 200, { chats: store.getChats() });
        return;
      }

      // Chat messages: GET /chats/:chatId/messages
      const chatMessagesMatch = pathname.match(/^\/chats\/([^/]+)\/messages$/);
      if (chatMessagesMatch && req.method === 'GET') {
        const chatId = decodeURIComponent(chatMessagesMatch[1]);
        const limit = Number(url.searchParams.get('limit')) || 50;
        const messages = store.getMessages(chatId, limit);
        sendJson(res, 200, { chatId, messages });
        return;
      }

      // Chat presence: POST /chats/:chatId/presence
      const presenceMatch = pathname.match(/^\/chats\/([^/]+)\/presence$/);
      if (presenceMatch && req.method === 'POST') {
        const chatId = decodeURIComponent(presenceMatch[1]);
        const body = await parseJsonBody(req);
        const action = body.action;
        if (!['composing', 'recording', 'paused'].includes(action)) {
          sendError(res, 400, 'Invalid action. Must be "composing", "recording", or "paused".');
          return;
        }
        const sock = getSocket ? getSocket() : null;
        if (!sock) {
          sendError(res, 503, 'WhatsApp client not connected');
          return;
        }
        await sock.sendPresenceUpdate(action, chatId);
        sendJson(res, 200, { status: 'ok', chatId, action });
        return;
      }

      // Chat read: POST /chats/:chatId/read
      const readMatch = pathname.match(/^\/chats\/([^/]+)\/read$/);
      if (readMatch && req.method === 'POST') {
        const chatId = decodeURIComponent(readMatch[1]);
        const body = await parseJsonBody(req);
        const sock = getSocket ? getSocket() : null;
        if (!sock) {
          sendError(res, 503, 'WhatsApp client not connected');
          return;
        }
        if (body.messageId) {
          await sock.readMessages([{ remoteJid: chatId, id: body.messageId }]);
        }
        store.markRead(chatId);
        sendJson(res, 200, { status: 'ok', chatId });
        return;
      }

      // Send message: POST /messages/send
      if (pathname === '/messages/send' && req.method === 'POST') {
        const body = await parseJsonBody(req);
        const target = normalizeJid(body.to);
        if (!target) {
          sendError(res, 400, '"to" recipient phone number or JID is required.');
          return;
        }
        if (!body.text && !body.mediaUrl) {
          sendError(res, 400, 'Either "text" or "mediaUrl" must be provided.');
          return;
        }

        const sock = getSocket ? getSocket() : null;
        if (!sock) {
          sendError(res, 503, 'WhatsApp client not connected');
          return;
        }

        let messageContent;
        if (body.mediaUrl) {
          const mediaType = body.mediaType || 'image';
          if (mediaType === 'image') {
            messageContent = { image: { url: body.mediaUrl }, caption: body.caption || body.text || '' };
          } else if (mediaType === 'document') {
            messageContent = {
              document: { url: body.mediaUrl },
              fileName: body.fileName || 'document',
              caption: body.caption || body.text || '',
            };
          } else if (mediaType === 'audio') {
            messageContent = { audio: { url: body.mediaUrl }, ptt: Boolean(body.ptt) };
          } else if (mediaType === 'video') {
            messageContent = { video: { url: body.mediaUrl }, caption: body.caption || body.text || '' };
          } else {
            sendError(res, 400, `Unsupported mediaType: ${mediaType}`);
            return;
          }
        } else {
          messageContent = { text: body.text };
        }

        const result = await sock.sendMessage(target, messageContent);
        const messageId = result?.key?.id || '';

        store.recordMessage({
          id: messageId,
          chatId: target,
          senderId: sock.user?.id || 'me',
          senderName: 'Me',
          fromMe: true,
          timestamp: Date.now(),
          type: body.mediaUrl ? (body.mediaType || 'image') : 'text',
          text: body.text || body.caption || `[${body.mediaType || 'media'}]`,
          rawMessage: messageContent,
        });

        logger.log?.(`[API] Sent message to ${target} (id: ${messageId})`);
        sendJson(res, 200, {
          status: 'sent',
          messageId,
          chatId: target,
        });
        return;
      }

      // Reply message: POST /messages/reply
      if (pathname === '/messages/reply' && req.method === 'POST') {
        const body = await parseJsonBody(req);
        const chatId = normalizeJid(body.chatId);
        if (!chatId) {
          sendError(res, 400, '"chatId" is required.');
          return;
        }
        if (!body.text) {
          sendError(res, 400, '"text" is required.');
          return;
        }
        if (!body.quotedMessageId) {
          sendError(res, 400, '"quotedMessageId" is required.');
          return;
        }

        const sock = getSocket ? getSocket() : null;
        if (!sock) {
          sendError(res, 503, 'WhatsApp client not connected');
          return;
        }

        const originalMsg = store.getMessage(chatId, body.quotedMessageId);
        const quotedKey = {
          remoteJid: chatId,
          id: body.quotedMessageId,
          participant: body.quotedParticipant || originalMsg?.senderId,
        };

        const quotedObject = {
          key: quotedKey,
          message: originalMsg?.rawMessage || { conversation: originalMsg?.text || '' },
        };

        const result = await sock.sendMessage(chatId, { text: body.text }, { quoted: quotedObject });
        const messageId = result?.key?.id || '';

        store.recordMessage({
          id: messageId,
          chatId,
          senderId: sock.user?.id || 'me',
          senderName: 'Me',
          fromMe: true,
          timestamp: Date.now(),
          type: 'text',
          text: body.text,
          rawMessage: { text: body.text },
        });

        logger.log?.(`[API] Sent reply to ${chatId} for ${body.quotedMessageId} (id: ${messageId})`);
        sendJson(res, 200, {
          status: 'sent',
          messageId,
          chatId,
        });
        return;
      }

      // React message: POST /messages/react
      if (pathname === '/messages/react' && req.method === 'POST') {
        const body = await parseJsonBody(req);
        const chatId = normalizeJid(body.chatId);
        if (!chatId) {
          sendError(res, 400, '"chatId" is required.');
          return;
        }
        if (!body.messageId) {
          sendError(res, 400, '"messageId" is required.');
          return;
        }
        if (typeof body.emoji !== 'string') {
          sendError(res, 400, '"emoji" must be a string (can be empty to remove reaction).');
          return;
        }

        const sock = getSocket ? getSocket() : null;
        if (!sock) {
          sendError(res, 503, 'WhatsApp client not connected');
          return;
        }

        const reactContent = {
          react: {
            text: body.emoji,
            key: {
              remoteJid: chatId,
              id: body.messageId,
            },
          },
        };

        const result = await sock.sendMessage(chatId, reactContent);
        logger.log?.(`[API] Sent reaction "${body.emoji}" to ${chatId}:${body.messageId}`);
        sendJson(res, 200, {
          status: 'sent',
          chatId,
          messageId: body.messageId,
          emoji: body.emoji,
        });
        return;
      }

      // Unknown endpoint
      sendError(res, 404, `Not Found: ${req.method} ${pathname}`);
    } catch (err) {
      logger.error?.('[API Error]', err);
      sendError(res, 500, `Internal Server Error: ${err.message}`);
    }
  });

  return {
    server,
    store,
    listen(port = 8080, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.listen(port, host, () => {
          resolve(server.address());
        });
        server.once('error', reject);
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
