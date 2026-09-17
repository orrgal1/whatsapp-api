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

## Install and set up

```sh
npm install
npm run setup
```

The interactive setup asks for the destination email address, delivery method, and the settings required by that method. If WhatsApp is not paired yet, it displays a QR code. On your phone, open WhatsApp, go to **Settings → Linked Devices → Link a Device**, and scan the code.

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
