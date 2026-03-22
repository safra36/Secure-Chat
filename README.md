# Secure Chat

A self-hosted, end-to-end encrypted chat application built for environments with **heavy network restrictions** where only HTTP traffic is permitted.

---

## Table of Contents

- [What is Secure Chat?](#what-is-secure-chat)
- [Why HTTP-Only? The Protocol Design](#why-http-only-the-protocol-design)
- [Security Architecture](#security-architecture)
  - [Identity System](#identity-system)
  - [User ID (Self-Certifying Identity)](#user-id-self-certifying-identity)
  - [Message Encryption (AES-256-GCM)](#message-encryption-aes-256-gcm)
  - [ECDH Key Exchange (secp256k1)](#ecdh-key-exchange-secp256k1)
  - [Authentication Token](#authentication-token)
  - [Chat Color Tokens](#chat-color-tokens)
  - [Key Derivation & Padding](#key-derivation--padding)
- [Features](#features)
- [Simple by Design](#simple-by-design)
- [Setup \& Installation](#setup--installation)
  - [Prerequisites](#prerequisites)
  - [Quick Start](#quick-start)
  - [Password Configuration](#password-configuration)
  - [TLS Certificates](#tls-certificates)
  - [Running in Production](#running-in-production)
- [Admin Configuration (.admin)](#admin-configuration-admin)
- [Bot SDK](#bot-sdk)
  - [How Bot Messaging Works](#how-bot-messaging-works)
  - [Creating a Bot](#creating-a-bot)
  - [BotClient API](#botclient-api)
  - [Bot in Regular Chats](#bot-in-regular-chats)
  - [Rich Messages (Glass Buttons)](#rich-messages-glass-buttons)
  - [Slash Command Autocomplete](#slash-command-autocomplete)
  - [TypeScript Support](#typescript-support)
  - [Example Bot](#example-bot)
- [Project Structure](#project-structure)

---

## What is Secure Chat?

Secure Chat is a **zero-dependency, self-hosted messaging application** designed from the ground up for environments where network access is heavily restricted. Unlike modern chat applications that rely on WebSockets, WebRTC, or proprietary protocols that get blocked by corporate proxies, firewalls, or DPI systems, Secure Chat uses **only standard HTTP** — the one protocol that works everywhere.

### Key Properties

- **Self-Hosted**: Your server, your data, your rules
- **End-to-End Encrypted**: Messages are encrypted on the client; the server never sees plaintext
- **Censorship-Resistant**: HTTP only — works through most proxies and firewalls
- **Zero External Dependencies**: Plain JavaScript on the client, Node.js on the server
- **PWA Support**: Install on mobile/desktop as a native-like app

---

## Why HTTP-Only? The Protocol Design

Most secure chat applications use WebSockets for real-time messaging or WebRTC for peer-to-peer connections. These protocols are often **blocked or heavily filtered** in:

- Corporate networks with strict proxy policies
- Countries with internet censorship
- Networks with deep packet inspection (DPI)
- Environments behind captive portals or restrictive firewalls

### The HTTP-Only Solution

Secure Chat embraces HTTP as its **only transport layer**:

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLIENT (Browser)                            │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐         │
│  │   Send Msg   │   │  Long Poll   │   │  Heartbeat   │         │
│  │  (POST /send)│   │(GET /messages│   │(POST /beat)  │         │
│  └──────────────┘   └──────────────┘   └──────────────┘         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ HTTP(S) ◄─────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                        SERVER (Node.js)                         │
│  • Authenticates requests via Ed25519 signatures                │
│  • Stores encrypted messages on disk                            │
│  • Relays file chunks between clients                           │
│  • Manages voice/video call routing                             │
└─────────────────────────────────────────────────────────────────┘
```

### How Real-Time Works Without WebSockets

Instead of persistent connections, the app uses **long-polling**:

1. **Sending**: `POST /send` — Client encrypts message and sends immediately
2. **Receiving**: `GET /messages/{chatHandle}?after={lastId}` — Client polls and server holds connection until:
   - New messages arrive (server responds immediately)
   - 30-second timeout (server responds with empty, client re-polls)
3. **Heartbeat**: `POST /heartbeat/{chatHandle}` — Tells server "I'm alive" every 15 seconds

This pattern works through **virtually any HTTP proxy** because it looks like normal web browsing.

---

## Security Architecture

### Identity System

Each user has a **permanent Ed25519 identity key pair** generated entirely on the client:

```javascript
// From encryption.js - Key generation
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',  // Note: Client uses Ed25519 via Web Crypto API
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
```

- **Private key**: Never leaves the device, stored in `localStorage`
- **Public key**: Shared freely, embedded in every auth token

### User ID (Self-Certifying Identity)

Your User ID is computed as:
```
UserID = SHA-256(rawPublicKeyBytes)
```

This creates a **self-certifying identity**:
- Anyone with your public key can verify your User ID
- The server cannot choose or forge your identity
- No central registry of user IDs needed

### Message Encryption (AES-256-GCM)

All messages use **AES-256-GCM** (Galois/Counter Mode):

```
┌─────────────────────────────────────────────────────────────────┐
│                        AES-256-GCM                              │
├─────────────────────────────────────────────────────────────────┤
│  Plaintext  ──►  [AES-256 Core]  ──►  Ciphertext               │
│                    │                                             │
│                    └──► Auth Tag (16 bytes)                      │
│                                                                 │
│  Output = IV (12 bytes) || Ciphertext || AuthTag (16 bytes)   │
└─────────────────────────────────────────────────────────────────┘
```

**Why GCM and not CBC?**
- **Authentication**: GCM produces an auth tag that detects tampering AND encryption errors
- **No padding oracle attacks**: Unlike CBC, GCM doesn't use padding
- **Parallelizable**: AES core can be parallelized in GCM mode
- **Nonce-based**: Each encryption uses a fresh random IV (12 bytes)

### ECDH Key Exchange (secp256k1)

For chat encryption keys, the app uses **Elliptic Curve Diffie-Hellman** with secp256k1:

```javascript
// Client generates ephemeral key pair for each chat
const ephemeral = crypto.generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
    // ...
});

// ECDH: combine own private with peer's public
const sharedSecret = crypto ECDH.computeSecret(peerPublicKey);
// Result is hashed to produce 32-byte AES key
```

**Why secp256k1?**
- Same curve as Bitcoin/Ethereum — widely audited and fast
- 32-byte public keys, 32-byte private keys
- Small signature sizes

### Authentication Token

Tokens prove you own the private key matching your User ID:

```
Authorization: {userId}:{base64(publicKey)}:{base64(signature)}

Token = userId:base64(publicKey):base64(Ed25519.sign(timeBucket, privateKey))
```

**Time Buckets**: Current time rounded down to nearest 5-second interval
```
timeBucket = floor(timestamp / 5000) * 5000
```

**Tolerance Window**: Server accepts signatures from ±60 seconds (12 buckets)
- Handles clock drift between clients and server
- Handles network delays without rejecting valid tokens

### Chat Color Tokens

Each chat room has a unique **visual identity color** computed as:

```javascript
colorToken = SHA-256(senderUserId + requestingUserId)
```

**Properties**:
- Same color shown to both participants in a 1:1 chat
- Different color if more people join
- Derived deterministically — no storage needed
- Used to render a colored border on messages (helps verify key continuity)

### Key Derivation & Padding

AES-256 requires a 32-byte key. The app handles variable-length inputs:

```javascript
function padKey(keyStr) {
    const data = Buffer.from(keyStr, 'utf8');
    const padded = Buffer.alloc(32);
    data.copy(padded, 0, 0, Math.min(data.length, 32));  // Truncate if >32 bytes
    return padded;  // Zero-padded if <32 bytes
}
```

**Note**: For password-derived keys (like `serverPassword`), the password is typically short, so this acts as a simple key stretching mechanism. For production use with passwords, consider Argon2 or PBKDF2.

---

## Features

| Feature | Description |
|---------|-------------|
| **1:1 Chat** | End-to-end encrypted direct messages |
| **Group Chat** | Shared conversations with multiple participants |
| **Broadcast Channels** | One-to-many messaging (e.g., announcements) |
| **Password-Protected Chats** | Chat rooms encrypted with an additional password |
| **File Transfer** | Chunked, encrypted file uploads/downloads |
| **Voice Calls** | Encrypted audio communication |
| **Video Calls** | Encrypted video communication |
| **Reactions** | Emoji reactions to messages |
| **Message Editing** | Edit sent messages |
| **Read Receipts** | See who has read messages |
| **PWA** | Install as a mobile/desktop app |
| **Offline Support** | Service worker caches assets |
| **Bots** | Programmable bots with rich button messages and slash commands |

---

## Simple by Design

Secure Chat prioritizes **simplicity and understandability**:

1. **Single File Storage**: Messages stored as NDJSON (newline-delimited JSON) — inspectable with any text editor
2. **No Build Step for Development**: Plain JavaScript, runs directly in browser
3. **No External CDNs**: All assets served locally — works offline
4. **Minimal Dependencies**: Server needs only Node.js standard library (no npm packages except for bundling)
5. **Transparent Protocol**: Every request/response is visible in browser DevTools
6. **Self-Contained Binaries**: Single executable builds for Linux using Node.js SEA

### What the Server Can't Do

Because of end-to-end encryption:
- ❌ Server cannot read your messages
- ❌ Server cannot modify your messages without detection
- ❌ Server cannot impersonate you
- ❌ Server doesn't know which chats you're in (only sees encrypted handles)
- ❌ Server doesn't store your private keys

### What the Server CAN Do

- ✅ Relay encrypted messages between clients
- ✅ Store encrypted message content on disk
- ✅ Verify Ed25519 signatures (authenticate users)
- ✅ Relay file chunks for transfer
- ✅ Route voice/video call data
- ✅ Manage read receipts and message metadata

---

## Setup & Installation

### Prerequisites

- **Node.js** 18+ (for server)
- **OpenSSL** (for TLS certificate generation)
- **Linux/macOS/Windows** with bash or PowerShell

### Quick Start

```bash
# 1. Clone or download the project
cd chatapp

# 2. Create the password file (change 'your-password' to something strong)
echo "your-password" > .passwd

# 3. Generate TLS certificates (for HTTPS)
mkdir -p assets/cert
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout assets/cert/key.pem -out assets/cert/cert.pem -days 365 -nodes \
  -subj "/CN=localhost"

# 4. Start the server
node server.js

# 5. Open in browser
# https://localhost:3000
```

### Password Configuration

The server password is loaded from a `.passwd` file in the project root:

```bash
echo "your-strong-password" > .passwd
```

**Important**: This password:
- Encrypts server-side stored data
- Protects password-locked chat rooms
- Signs the server build ID (prevents forged reload attacks)

### TLS Certificates

The server requires TLS certificates to run. Place them in:

```
assets/cert/cert.pem   # Certificate
assets/cert/key.pem    # Private key
```

Or in the root `cert/` directory for development:

```
cert/cert.pem
cert/key.pem
```

**Self-signed certificates**: Browsers will warn about insecure certificates. Accept the warning to proceed (the app is still encrypted end-to-end).

### Running in Production

```bash
# Use a process manager
npm install -g pm2
pm2 start server.js --name secure-chat

# Or run as a systemd service
sudo nano /etc/systemd/system/secure-chat.service
```

Example systemd service:
```ini
[Unit]
Description=Secure Chat Server
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/chatapp
ExecStart=/path/to/chatapp/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable secure-chat
sudo systemctl start secure-chat
```

---

## Admin Configuration (.admin)

The `.admin` file designates a **channel admin** — the user who can post to the built-in `System News` broadcast channel and manage bots.

### Format

The file contains a single line: the User ID (SHA-256 of the user's raw Ed25519 public key, 64 hex chars).

```
32b097f254dced108676ac6dbb8d7a814253eda98eeae23cc67ca59bab16c07a
```

### How to find your User ID

Open the app → tap your avatar or profile — your User ID is displayed there. Copy the full 64-character hex string.

### Creating the file

```bash
echo "YOUR_USER_ID_HERE" > .admin
```

Place it in the project root (same directory as `server.js`). The server reads it at startup:

```
✅ Channel admin loaded      # .admin found and valid
⚠️  No .admin file — ...    # file missing or empty
```

### What the admin can do

| Permission | Description |
|---|---|
| Post to System News | Only the admin user can send messages to the broadcast channel |
| Create bot invites | Admin UI shows a `+` button to generate bot invite tokens |
| Delete bots | Admin can remove registered bots via the UI |

> **Note**: If no `.admin` file exists, the System News channel is read-only for everyone and bot management is disabled.

---

## Bot SDK

Bots are **external Node.js processes** that connect to the server via a secure API. They are fully independent — they can run on any machine that can reach the server.

### How Bot Messaging Works

```
User ──(HTTPS, AES-GCM server key)──► Server ──(AES-GCM shared key)──► Bot
Bot  ──(HTTPS, AES-GCM shared key)──► Server ──(AES-GCM server key)──► User
```

- **User → Server**: message encrypted with the server password key (AES-256-GCM)
- **Server → Bot**: inbox payload encrypted with the `sharedKey` (unique per bot)
- **Bot → Server**: reply encrypted with the `sharedKey`
- **Server → User**: messages response encrypted with the server password key

The `sharedKey` is generated by the server at invite time and is **only known to the server and the bot process** — clients never see it.

Bot authentication uses the same **Ed25519 time-bucket signature** scheme as users:
```
Authorization: {botId}:{base64(rawPublicKey)}:{base64(Ed25519.sign(timeBucket, privateKey))}
```

### Creating a Bot

**Step 1 — Generate an invite** (admin only)

In the app, open **Bots** → click the `+` button. The server generates a one-time `inviteToken` and a `sharedKey`. Copy both.

**Step 2 — Configure your bot script**

```js
const SHARED_KEY   = 'paste-64-char-hex-shared-key-here';
const INVITE_TOKEN = 'paste-64-char-hex-invite-token-here';
```

Or use environment variables:

```bash
BOT_SHARED_KEY=...   BOT_INVITE_TOKEN=...   node bot/example.js --activate
```

**Step 3 — Activate (one-time)**

```bash
node bot/example.js --activate
```

This registers the bot with the server, saves the Ed25519 key pair to `bot-keys.json`, and makes the bot appear in the Bots tab. You only do this once.

**Step 4 — Run**

```bash
node bot/example.js
```

The bot polls its inbox every 2 seconds and responds to messages.

### BotClient API

```js
const { BotClient } = require('./bot-sdk');

const bot = new BotClient({
    serverUrl:    'https://localhost:3000',
    sharedKey:    '64-char-hex',       // from admin invite
    keysFile:     './bot-keys.json',   // Ed25519 keys (auto-generated)
    pollInterval: 2000,                // inbox poll ms (default: 2000)
});
```

**Lifecycle**

| Method | Description |
|---|---|
| `bot.activate({ inviteToken, name, description, svgIcon })` | One-time registration. Generates Ed25519 + P-256 ECDH keys and registers with server. |
| `bot.start()` | Load keys and begin polling the inbox. |
| `bot.stop()` | Stop polling. |
| `bot.name` | The bot's display name (read-only, available after `start()`/`activate()`). |

**Direct Messages**

| Method | Description |
|---|---|
| `bot.onMessage(async (userId, content, messageId) => {})` | Called for each direct message from a user. |
| `bot.reply(userId, content)` | Send a plain text reply to a user. |
| `bot.replyRich(userId, content, buttons)` | Send a reply with interactive glass buttons. |

**Regular Chat (Group)**

| Method | Description |
|---|---|
| `bot.onJoin(async (chatHandle, encryptionKey) => {})` | Called when the bot is added to a chat. Persist `encryptionKey` for later use. |
| `bot.onLeave(async (chatHandle) => {})` | Called when the bot is removed from a chat. |
| `bot.onChatMessage(async (chatHandle, content, senderUserId, messageId) => {})` | Called for each message in a chat the bot has joined. |
| `bot.onMention(async (chatHandle, content, senderUserId, messageId) => {})` | Called when the bot is @mentioned. Falls back to `onChatMessage` if not set. |
| `bot.sendToChat(chatHandle, content, encryptionKey)` | Send a plain text message to a group chat. |
| `bot.sendRichToChat(chatHandle, content, buttons, encryptionKey)` | Send a message with glass buttons to a group chat. |
| `bot.setTyping(chatHandle, isTyping)` | Show/hide the bot's typing indicator in a chat (auto-clears after 6 s). |
| `bot.setChatKey(chatHandle, encryptionKey)` | Pre-load a chat key on restart (before messages arrive). |

**Other**

| Method | Description |
|---|---|
| `bot.setCommands(commands)` | Register slash commands shown in the client autocomplete. |
| `bot.onError((err) => {})` | Register an error handler. |

### Bot in Regular Chats

Bots can be added to any group chat by a member via **Chat Settings → Add Bot**. Once added:

1. The server sends a `join` event to the bot's inbox containing the chat's `encryptionKey` — wrapped with the bot's P-256 ECDH public key so only the bot can unwrap it.
2. The bot stores the key (e.g. to disk) and uses it to encrypt/decrypt all messages in that chat.
3. When the bot is removed, a `leave` event is delivered.

```js
const fs = require('fs');
const CHATS_FILE = './bot-chats.json';

bot.onJoin(async (chatHandle, encryptionKey) => {
    // Persist the key — you'll need it after restarts
    const keys = JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8') || '{}');
    keys[chatHandle] = encryptionKey;
    fs.writeFileSync(CHATS_FILE, JSON.stringify(keys, null, 2));
    await bot.sendToChat(chatHandle, '👋 Hello! Type /help to see what I can do.', encryptionKey);
});

bot.onLeave(async (chatHandle) => {
    const keys = JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8') || '{}');
    delete keys[chatHandle];
    fs.writeFileSync(CHATS_FILE, JSON.stringify(keys, null, 2));
});

bot.onChatMessage(async (chatHandle, content, senderUserId, messageId) => {
    const keys = JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8') || '{}');
    const encryptionKey = keys[chatHandle];
    if (!encryptionKey) return;
    await bot.sendToChat(chatHandle, `Echo: ${content}`, encryptionKey);
});
```

After a restart, restore saved keys before calling `start()`:

```js
for (const [chatHandle, encryptionKey] of Object.entries(savedChats)) {
    bot.setChatKey(chatHandle, encryptionKey);
}
await bot.start();
```

#### @Mentions

When a user types `@BotName` in a chat message, the server routes a `mention` event to that bot. Register `onMention` to handle it separately from regular chat messages (strip the `@BotName` prefix before processing):

```js
bot.onMention(async (chatHandle, content, senderUserId, messageId) => {
    const encryptionKey = savedKeys[chatHandle];
    if (!encryptionKey) return;
    // content still includes "@BotName ..." — strip it:
    const prefix = '@' + bot.name;
    const text = content.toLowerCase().startsWith(prefix.toLowerCase())
        ? content.slice(prefix.length).trimStart()
        : content.trim();
    await bot.sendToChat(chatHandle, `You said: ${text}`, encryptionKey);
});
```

#### Typing Indicator

Call `setTyping` to show the bot's name in the chat's typing indicator. It auto-expires after 6 seconds if not refreshed, so call it periodically for long operations and call it with `false` when done:

```js
await bot.setTyping(chatHandle, true);
// ... do work ...
await bot.setTyping(chatHandle, false);
```

### Rich Messages (Glass Buttons)

`replyRich` sends interactive button rows rendered inline in the chat:

```js
await bot.replyRich(userId, 'Pick an option:', [
    { label: '✅ Yes',  value: 'yes' },
    { label: '❌ No',   value: 'no' },
]);
```

- `label` — display text on the button
- `value` — the string sent back to the bot when clicked (same as if the user typed it)

When a button is clicked, all buttons in that row are disabled to prevent double-submission.

### Slash Command Autocomplete

Register commands once after `bot.start()`. They appear as an autocomplete popup when the user types `/` in the bot chat input:

```js
await bot.setCommands([
    { name: 'help',  description: 'Show available commands' },
    { name: 'calc',  description: 'Calculate an expression, e.g. /calc 2+3*4' },
    { name: 'roll',  description: 'Roll a die, e.g. /roll 20' },
]);
```

- Popup appears on `/`, filters as the user continues typing
- Arrow up/down to navigate, Enter or click to select, Escape to dismiss
- Commands are stored server-side and returned with the bot listing — no extra round-trip at chat open time

### TypeScript Support

`bot/bot-sdk.d.ts` ships with the SDK. Import it in TypeScript projects:

```ts
import { BotClient, BotClientOptions, Button, BotCommand,
         MessageHandler, ChatMessageHandler, MentionHandler,
         JoinHandler, LeaveHandler } from './bot-sdk';

const bot = new BotClient({
    serverUrl: 'https://localhost:3000',
    sharedKey:  process.env.BOT_SHARED_KEY!,
});

bot.onMessage(async (userId, content) => {
    await bot.reply(userId, `Echo: ${content}`);
});
```

Or in CommonJS with type assertions:

```js
const { BotClient } = /** @type {typeof import('./bot-sdk')} */ (require('./bot-sdk'));
```

### Example Bot

`bot/example.js` is a fully-featured demo bot:

| Command | Action |
|---|---|
| `/help` | Rich card with 4 navigation buttons |
| `/quiz` | 5-question trivia with A/B/C/D glass buttons per question |
| `/calc <expr>` | Safe math evaluator (`/calc 12*34`, `2^10`, `(5+3)/2`) |
| `/roll [N]` | Roll an N-sided die (default d6) |
| `/score` | Show your quiz history |
| `/delay [N]` | Show typing indicator for N seconds (1–10, default 3). Chat only. |

The example bot works in both **direct conversations** and **group chats** (including @mention support). Quiz sessions are tracked per-user in memory. The calculator uses a regex whitelist — no `eval` on untrusted input.

---

## Project Structure

```
chatapp/
├── login.html               # Entire client app (HTML + JS + CSS, single file)
├── server.js                # All server logic (~3700 lines)
├── encryption.js            # AES-256-GCM + ECDH helpers (Node.js)
├── content-cache-db.js      # IndexedDB wrapper for media content cache
├── p2p-transfer-manager.js  # Peer-to-peer file transfer logic
├── sw.js                    # Service worker (PWA offline support)
├── manifest.json            # PWA manifest
├── build.js                 # Build/bundle script
├── .passwd                  # Server password — you create this
├── .admin                   # Channel admin User ID — you create this (optional)
├── bot/
│   ├── bot-sdk.js           # BotClient SDK (require this in your bot)
│   ├── bot-sdk.d.ts         # TypeScript type definitions for bot-sdk.js
│   ├── example.js           # Demo bot: quiz, calc, dice, slash commands, @mentions
│   ├── encryption.js        # Encryption helpers (copy of root encryption.js)
│   ├── bot-keys.json        # Ed25519 + P-256 ECDH keys — auto-generated on first activate
│   └── bot-keys-state.json  # Last-seen inbox ID — auto-managed
├── assets/
│   ├── cert/                # TLS certificates
│   └── icons/               # App icons
├── bin/
│   └── node                 # Node.js binary (for SEA single-executable builds)
├── data/                    # Message + bot conversation storage (runtime)
└── dist/                    # Build output
```

---

## Algorithm Summary

| Purpose | Algorithm | Why |
|---------|-----------|-----|
| **Identity Keys** | Ed25519 | Fast signatures, small keys, widely audited |
| **Key Exchange** | ECDH secp256k1 | Bitcoin-standard curve, good performance |
| **Message Encryption** | AES-256-GCM | Authenticated encryption, no padding oracle |
| **User ID** | SHA-256 | Deterministic, self-certifying identity |
| **Chat Colors** | SHA-256 | Deterministic per-chat colors |
| **Key Padding** | Zero-truncate to 32 bytes | Simple key stretching for short passwords |
| **Time Sync** | AES-GCM encrypted server time | Prevents timing attacks on auth |
| **Build Verification** | HMAC-SHA256 | Server-signed build ID prevents forged reloads |

---

## License

MIT License — Use freely, audit always.
