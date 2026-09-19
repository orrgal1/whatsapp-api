# WhatsApp Email Forwarder

A macOS-only background service that forwards incoming WhatsApp messages to email. It uses the unofficial Baileys WhatsApp Web client and can deliver mail through an already authenticated `gapi` installation or Gmail SMTP.

> **Account-risk warning:** Baileys is an unofficial WhatsApp Web client and is not endorsed or supported by WhatsApp. Using unofficial clients may violate WhatsApp's terms and may lead to temporary or permanent account restrictions or bans. Use this project at your own risk, preferably with an account you can afford to lose.

## Prerequisites

- macOS
- Node.js and npm
- WhatsApp on a phone that can scan a linked-device QR code
- One email delivery method:
  - **gapi:** `gapi` installed and already authenticated for Gmail
  - **Gmail SMTP:** a Google Account with 2-Step Verification enabled and an [app password](https://support.google.com/accounts/answer/185833). Do not use your normal Google Account password.

## One-line coding-harness setup

Paste this into any coding harness:

```text
Set up <repository-url> on this Mac: clone it into a suitable local directory, run npm install and npm run setup, guide me through forwarding email registration and WhatsApp QR pairing, verify the launchd service is running, and never expose or commit config.json, excluded-conversations.json, .whatsapp-auth, or logs.
```

## Install and set up

```sh
npm install
npm run setup
```

The interactive setup registers the forwarding email address, asks for the delivery method, and configures the settings required by that method. If WhatsApp is not paired yet, it displays a QR code. On your phone, open WhatsApp, go to **Settings → Linked Devices → Link a Device**, and scan the code.

Setup writes local `config.json` and `excluded-conversations.json` files, pairs WhatsApp, then installs and starts the per-user macOS launchd service. These local files and WhatsApp credentials are gitignored.

### Delivery choices

- **gapi:** choose this to keep using a local, authenticated `gapi` Gmail setup. Enter the command requested by setup. Authentication must already be complete before the service starts.
- **Gmail SMTP:** use host `smtp.gmail.com`. Use port `465` with a secure connection, or port `587` without the secure option (STARTTLS is negotiated). Enter your full Gmail address as the user and a Google app password as the password.

## Conversation filters

Edit `excluded-conversations.json` to prevent selected chats from being forwarded:

```json
{
  "names": ["Muted group"],
  "ids": ["conversation-id"]
}
```

Add exact conversation names to `names` or exact WhatsApp conversation IDs to `ids`. Keep either array empty if it is not needed, and preserve valid JSON when editing.

## Run and manage

Run the forwarder in the foreground:

```sh
npm start
```

Check the installed service:

```sh
npm run service:status
```

Stop and remove the launchd service:

```sh
npm run service:uninstall
```

Run `npm run setup` again to update configuration, repair pairing, or reinstall the service.

## WhatsApp Chat Interactions API

An authenticated HTTP API runs alongside the forwarder, allowing remote agents and services to inspect chats, send messages, reply to threads, and react with emojis.

- **OpenAPI Schema (Inspection):** `GET /openapi.json` (unauthenticated for agent discovery)
- **Interactive Swagger UI:** `GET /docs`
- **Authentication:** `Authorization: Bearer <TOKEN>` on all protected endpoints

### Endpoints

- `GET /health` — Check WhatsApp connection state, linked phone number, and uptime.
- `GET /contacts` — List all known contacts with display names and phone numbers.
- `GET /contacts/search?q=...` — Search contacts and chats by name or phone, and verify WhatsApp registration.
- `GET /chats` — List recent conversations with bound contact names, phone numbers, and unread counts.
- `GET /chats/search?q=...` — Search recent chats by contact name, phone number, JID, or message contents.
- `GET /chats/{chatId}/messages?limit=20` — Fetch recent message history in a chat for context.
- `POST /messages/send` — Send a new text or media message to a phone number or JID.
- `POST /messages/reply` — Reply directly to a message by quoting its message ID.
- `POST /messages/react` — Add an emoji reaction to a message (or empty string to remove).
- `POST /chats/{chatId}/presence` — Send `composing`, `recording`, or `paused` indicator.
- `POST /chats/{chatId}/read` — Mark a chat or specific message as read.

### Remote Agent Quick Reference

#### 1. Inspect OpenAPI Specification
```bash
curl -s http://localhost:8080/openapi.json | jq .
```

#### 2. Check Health & Connection
```bash
curl -X GET http://localhost:8080/health \
  -H "Authorization: Bearer $TOKEN"
```

#### 3. List Recent Chats
```bash
curl -X GET http://localhost:8080/chats \
  -H "Authorization: Bearer $TOKEN"
```
#### 4. Search Contacts & Resolve Identity
```bash
curl -X GET "http://localhost:8080/contacts/search?q=Alice" \
  -H "Authorization: Bearer $TOKEN"
```

#### 5. Send a Message
```bash
curl -X POST http://localhost:8080/messages/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+1234567890",
    "text": "Hello from agent!"
  }'
```

#### 6. Reply to a Specific Message
```bash
curl -X POST http://localhost:8080/messages/reply \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "1234567890@s.whatsapp.net",
    "quotedMessageId": "3EB012345678",
    "text": "Sounds good!"
  }'
```

#### 7. React to a Message
```bash
curl -X POST http://localhost:8080/messages/react \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "1234567890@s.whatsapp.net",
    "messageId": "3EB012345678",
    "emoji": "👍"
  }'
```

### Exposing Publicly via Tunnel

To expose the API to remote agents securely, use a Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:8080
```

## Message and media behavior

Text messages are forwarded in the email body. Media is described using available details such as its caption, type, or filename; media files are not downloaded and attached to the email.

## Troubleshooting

- **No QR code appears:** WhatsApp may already be paired. If forwarding still does not work, run `npm run setup` again and follow its pairing prompts.
- **QR code expires or pairing fails:** rerun `npm run setup`, keep the phone online, and scan the new code promptly.
- **gapi delivery fails:** confirm `gapi` is installed, the configured command is available without an interactive shell, and Gmail authentication is still valid.
- **Gmail SMTP rejects login:** confirm 2-Step Verification is enabled, use an app password rather than the account password, and check the Gmail address, host, port, and secure setting.
- **Service is not running:** inspect `npm run service:status`, then rerun `npm run setup` to reinstall and start it.
- **A chat is still forwarded:** verify that its exact name or ID is in the appropriate array and that `excluded-conversations.json` is valid JSON.

## Privacy and security

WhatsApp pairing credentials in `.whatsapp-auth`, email settings in `config.json`, filters in `excluded-conversations.json`, and local logs may contain sensitive information. Keep them private, never commit or share them, and restrict access to your macOS user account. SMTP app passwords are stored locally in `config.json`; revoke the app password in your Google Account if it is exposed or no longer used.

Messages are processed locally, but their contents are sent to the configured email provider. Review that provider's privacy and retention policies before use.

## License

MIT
