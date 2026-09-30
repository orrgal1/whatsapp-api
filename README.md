# WhatsApp API

This Mac runs a local WhatsApp REST API through an unofficial Baileys linked device. The stable entry point is `https://ors-macbook-air.taila51d65.ts.net/whatsapp-api/`. Sign in at `/login`; the gateway injects the bearer token server-side. WhatsApp pairing stays locally in `.whatsapp-auth/`.

Baileys is not endorsed by WhatsApp. Unofficial clients can put an account at risk.

## Setup and service

Requires macOS, Node.js, npm, and WhatsApp on a phone for the first pairing.

```sh
npm install
npm run setup
npm run service:status
```

Setup writes the gitignored `config.json`, pairs a device if needed, and installs `com.local.whatsapp-api`. It preserves an existing `.whatsapp-auth/` pairing. To stop the service, run `npm run service:uninstall`. To run in the foreground, use `python3 ../local-api-gateway/run_service.py whatsapp-api node server.mjs`.

The former email forwarder has been removed. No WhatsApp message is automatically emailed. Instinct reads messages from authenticated GET routes when needed.

## Read routes

- `GET /health` reports the linked device connection and cache counts.
- `GET /contacts` and `GET /contacts/search?q=...` list and find known contacts.
- `GET /chats` and `GET /chats/search?q=...` list and find known chats.
- `GET /messages?limit=100&since=<unix-ms>&q=<text>&chatId=<jid>` lists or searches retained messages across chats. All filters are optional; limit is at most 500. Messages are newest first.
- `GET /chats/{chatId}/messages?limit=20` reads a chat's recent messages.
- `GET /chats/{chatId}/messages/{messageId}/media` downloads retained media on demand, up to 50 MiB.

The message cache holds at most 100 messages per chat and 500 chats. Normalized message metadata and text persist in the owner-only, gitignored `chat-cache.sqlite3`, so reads survive service restarts. Raw WhatsApp protocol data and media bytes are never persisted; media downloads are available only while the source message remains in memory in the current process. Older messages from before this cache was added appear only if WhatsApp history sync provides them again. Pollers should track message IDs and use `since` with overlap to avoid losing messages that share a timestamp. Message read responses omit raw WhatsApp protocol data.

## Write routes

- `POST /messages/send` sends text or media.
- `POST /messages/reply` replies with a quoted message.
- `POST /messages/react` reacts to a message.
- `POST /chats/{chatId}/presence` updates presence.
- `POST /chats/{chatId}/read` marks a chat read.

`GET /openapi.json` documents request and response shapes. `GET /docs` provides Swagger UI. Direct local routes require `Authorization: Bearer <SHARED_BEARER_TOKEN>`; remote clients use the gateway session cookie. Keep `config.json`, `.whatsapp-auth/`, `chat-cache.sqlite3`, and logs private.
