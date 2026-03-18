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

## Project Structure

```
chatapp/
├── index.html          # Main application (all JS/CSS embedded)
├── login.html          # Login page
├── auth.js             # Client-side authentication
├── encryption.js       # Client-side encryption (Node.js version)
├── p2p-transfer-manager.js  # File transfer logic
├── server.js           # Server implementation
├── sw.js               # Service worker (PWA offline support)
├── manifest.json       # PWA manifest
├── build.js            # Build script for bundling
├── .passwd             # Server password (you create this)
├── assets/
│   ├── cert/           # TLS certificates
│   └── icons/          # App icons
├── bin/
│   └── node            # Node.js binary (for SEA builds)
├── data/               # Message storage (created at runtime)
└── dist/               # Build output
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
