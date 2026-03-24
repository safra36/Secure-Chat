'use strict';
/**
 * Bot SDK for Secure Chat
 *
 * Bots authenticate identically to users:
 *   Authorization: {botId}:{base64(rawPubKey)}:{base64(Ed25519Sig)}
 *   where botId = SHA256(rawPubKey) and sig covers the 5-second time bucket
 *
 * Server↔bot payloads are AES-256-GCM encrypted with the sharedKey.
 *
 * Usage:
 *   const { BotClient } = require('./bot-sdk');
 *   const bot = new BotClient({ serverUrl, sharedKey, keysFile });
 *   await bot.activate({ inviteToken, name, description, svgIcon });
 *   bot.onMessage(async (userId, content, messageId) => {
 *     await bot.reply(userId, 'pong: ' + content);
 *   });
 *   await bot.start();
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');

// ── Crypto helpers ────────────────────────────────────────────────────────────

function _botEncrypt(obj, sharedKeyHex) {
    const key = Buffer.from(sharedKeyHex, 'hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let enc = cipher.update(JSON.stringify(obj), 'utf8', 'binary');
    enc += cipher.final('binary');
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, Buffer.from(enc, 'binary'), tag]).toString('base64');
}

function _botDecrypt(base64, sharedKeyHex) {
    const key = Buffer.from(sharedKeyHex, 'hex');
    const data = Buffer.from(base64, 'base64');
    const iv = data.slice(0, 12);
    const tag = data.slice(-16);
    const enc = data.slice(12, -16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let dec = decipher.update(enc, 'binary', 'utf8');
    dec += decipher.final('utf8');
    return JSON.parse(dec);
}

/**
 * Derive raw 32-byte public key from an Ed25519 CryptoKey (SPKI DER format).
 * SPKI header for Ed25519 is always exactly 12 bytes: 302a300506032b6570032100
 */
function _rawPublicKeyFromDer(spkiDerBuf) {
    return spkiDerBuf.slice(12); // 12-byte header, 32-byte raw key
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function _request(serverUrl, method, pathname, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(serverUrl);
        const lib = parsed.protocol === 'https:' ? https : http;
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: pathname,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...headers,
            },
            // Skip certificate verification for self-signed certs in development
            rejectUnauthorized: false,
        };
        const req = lib.request(options, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve(data); }
            });
        });
        req.on('error', reject);
        if (body !== undefined && body !== null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

// ── Chat key helpers (matches client's encryptMessage / decryptMessage) ────────

function _padChatKey(keyStr) {
    const data = Buffer.from(keyStr, 'utf8');
    const padded = Buffer.alloc(32);
    data.copy(padded, 0, 0, Math.min(data.length, 32));
    return padded;
}

function _encryptWithChatKey(text, encryptionKey) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', _padChatKey(encryptionKey), iv);
    let enc = cipher.update(text, 'utf8', 'binary');
    enc += cipher.final('binary');
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, Buffer.from(enc, 'binary'), tag]).toString('base64');
}

function _decryptWithChatKey(base64, encryptionKey) {
    const data = Buffer.from(base64, 'base64');
    const iv = data.slice(0, 12);
    const tag = data.slice(-16);
    const enc = data.slice(12, -16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', _padChatKey(encryptionKey), iv);
    decipher.setAuthTag(tag);
    let dec = decipher.update(enc, 'binary', 'utf8');
    dec += decipher.final('utf8');
    return dec;
}

// ── BotClient ─────────────────────────────────────────────────────────────────

class BotClient {
    /**
     * @param {object} opts
     * @param {string} opts.serverUrl      - e.g. 'https://localhost:3000'
     * @param {string} opts.sharedKey      - 64-char hex (32 bytes), from admin
     * @param {string} [opts.keysFile]     - path to persist Ed25519 keys (default: ./bot-keys.json)
     * @param {number} [opts.pollInterval] - inbox poll interval ms (default: 2000)
     */
    constructor({ serverUrl, sharedKey, keysFile, pollInterval = 2000 }) {
        if (!serverUrl) throw new Error('serverUrl is required');
        if (!sharedKey || sharedKey.length !== 64) throw new Error('sharedKey must be a 64-char hex string (32 bytes)');
        this.serverUrl = serverUrl.replace(/\/$/, '');
        this.sharedKey = sharedKey;
        this.keysFile = keysFile || path.join(process.cwd(), 'bot-keys.json');
        this.stateFile = this.keysFile.replace(/\.json$/, '-state.json');
        this.pollInterval = pollInterval;

        this.botId = null;
        this._privateKey = null;      // Ed25519 crypto.KeyObject
        this._publicKeyRaw = null;    // Buffer (32 bytes)
        this._ecdhPrivKey = null;      // Buffer (32-byte P-256 scalar)
        this._ecdhPubKeyRaw = null;    // Buffer (65-byte uncompressed P-256 point)
        this._botName = null;
        this._messageHandler = null;
        this._joinHandler = null;
        this._leaveHandler = null;
        this._chatMessageHandler = null;
        this._mentionHandler = null;
        this._errorHandler = (e) => console.error('[BotClient]', e);
        this._pollTimer = null;
        this._lastInboxId = null;     // persisted in stateFile
        this._running = false;
        this._chatKeys = new Map();   // chatHandle -> encryptionKey (plaintext)
    }

    // ── Registration ───────────────────────────────────────────────────────

    /**
     * One-time activation. Generates Ed25519 keys, registers with server.
     * Saves keys to keysFile. After this, call start() for polling.
     *
     * @param {object} opts
     * @param {string} opts.inviteToken - 64-char hex invite token from admin
     * @param {string} opts.name        - Bot display name (max 64 chars)
     * @param {string} [opts.description] - Short description (max 256 chars)
     * @param {string} [opts.svgIcon]   - Raw SVG markup for bot icon (max 16KB)
     * @returns {Promise<{ botId: string }>}
     */
    async activate({ inviteToken, name, description = '', svgIcon = '' }) {
        if (!inviteToken) throw new Error('inviteToken is required');
        if (!name) throw new Error('name is required');

        await this._loadOrGenerateKeys();

        this._botName = name;
        const payload = _botEncrypt(
            {
                publicKey: this._publicKeyRaw.toString('base64'),
                ecdhPublicKey: this._ecdhPubKeyRaw.toString('base64'),
                name, description, svgIcon,
            },
            this.sharedKey
        );

        const result = await _request(
            this.serverUrl,
            'POST',
            '/bots/activate',
            payload,
            { 'Authorization': `Invite ${inviteToken}`, 'Content-Type': 'text/plain' }
        );

        if (!result.botId) throw new Error('Activation failed: ' + JSON.stringify(result));
        if (result.botId !== this.botId) throw new Error(`botId mismatch: got ${result.botId}, expected ${this.botId}`);

        // Persist name for use in sendToChat
        try {
            const saved = JSON.parse(fs.readFileSync(this.keysFile, 'utf8'));
            saved.name = name;
            fs.writeFileSync(this.keysFile, JSON.stringify(saved, null, 2));
        } catch (e) {}

        console.log(`[BotClient] Activated. botId: ${this.botId}`);
        return { botId: this.botId };
    }

    // ── Runtime ────────────────────────────────────────────────────────────

    /**
     * Register a message handler. Called for each user message.
     * @param {function} fn - async (userId, content, messageId) => void
     */
    onMessage(fn) {
        this._messageHandler = fn;
    }

    /**
     * Register an error handler.
     * @param {function} fn - (error) => void
     */
    onError(fn) {
        this._errorHandler = fn;
    }

    /**
     * Pre-load a chat key (e.g. restored from persistent storage on restart).
     * Must be called before start() or after start() before messages arrive.
     * @param {string} chatHandle
     * @param {string} encryptionKey
     */
    setChatKey(chatHandle, encryptionKey) {
        this._chatKeys.set(chatHandle, encryptionKey);
    }

    /**
     * Called when bot is added to a chat. fn receives the chat handle and the
     * plaintext encryptionKey — store it however you need (memory, encrypted file, etc).
     * @param {function} fn - async (chatHandle, encryptionKey) => void
     */
    onJoin(fn) {
        this._joinHandler = fn;
    }

    /**
     * Called when bot is removed from a chat (forwarding stops; key is not revoked).
     * @param {function} fn - async (chatHandle) => void
     */
    onLeave(fn) {
        this._leaveHandler = fn;
    }

    /**
     * Called for each message received in a chat the bot has joined.
     * @param {function} fn - async (chatHandle, content, senderUserId, messageId) => void
     */
    onChatMessage(fn) {
        this._chatMessageHandler = fn;
    }

    /** The bot's display name (available after start/activate). */
    get name() { return this._botName || ''; }

    /**
     * Signal typing state in a chat. Clears automatically after 6s if not refreshed.
     * @param {string} chatHandle
     * @param {boolean} isTyping
     */
    async setTyping(chatHandle, isTyping) {
        const payload = _botEncrypt({ typing: !!isTyping }, this.sharedKey);
        await _request(
            this.serverUrl,
            'POST',
            `/bot/${this.botId}/typing/${encodeURIComponent(chatHandle)}`,
            payload,
            { 'Authorization': await this._getAuthHeader(), 'Content-Type': 'text/plain' }
        );
    }

    /**
     * Called when the bot is @mentioned in a chat message.
     * Falls back to onChatMessage if not registered.
     * @param {function} fn - async (chatHandle, content, senderUserId, messageId) => void
     */
    onMention(fn) {
        this._mentionHandler = fn;
    }

    /**
     * Start polling the inbox. Loads keys from keysFile.
     */
    async start() {
        await this._loadOrGenerateKeys();
        if (!this.botId) throw new Error('Bot not activated. Call activate() first.');
        this._loadState();
        this._running = true;
        console.log(`[BotClient] Started. botId: ${this.botId}, lastInboxId: ${this._lastInboxId || 'none'}`);
        this._schedulePoll();
    }

    /**
     * Stop polling.
     */
    stop() {
        this._running = false;
        if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
        console.log('[BotClient] Stopped.');
    }

    /**
     * Send a reply to a user.
     * @param {string} userId
     * @param {string} content
     */
    async reply(userId, content) {
        const payload = _botEncrypt({ userId, content }, this.sharedKey);
        await _request(
            this.serverUrl,
            'POST',
            `/bot/${this.botId}/reply`,
            payload,
            { 'Authorization': await this._getAuthHeader(), 'Content-Type': 'text/plain' }
        );
    }

    /**
     * Register slash commands shown in the client autocomplete.
     * @param {Array<{name:string, description:string}>} commands
     */
    async setCommands(commands) {
        const payload = _botEncrypt({ commands }, this.sharedKey);
        await _request(
            this.serverUrl,
            'POST',
            `/bot/${this.botId}/commands`,
            payload,
            { 'Authorization': await this._getAuthHeader(), 'Content-Type': 'text/plain' }
        );
    }

    /**
     * Send a reply with rich content (glass buttons) to a user.
     * @param {string} userId
     * @param {string} content
     * @param {Array<{label:string,value:string}>|RichContent} richContent
     */
    async replyRich(userId, content, richContent) {
        const rc = Array.isArray(richContent) ? { buttons: richContent } : (richContent || {});
        const payload = _botEncrypt({ userId, content, richContent: rc }, this.sharedKey);
        await _request(
            this.serverUrl,
            'POST',
            `/bot/${this.botId}/reply`,
            payload,
            { 'Authorization': await this._getAuthHeader(), 'Content-Type': 'text/plain' }
        );
    }

    /**
     * Send a message to a regular chat the bot has joined.
     * @param {string} chatHandle
     * @param {string} content
     * @param {string} encryptionKey - the chat's encryption key (from onJoin or stored)
     */
    async sendToChat(chatHandle, content, encryptionKey) {
        const encryptedContent = _encryptWithChatKey(content, encryptionKey);
        const encryptedName = _encryptWithChatKey(this._botName || 'Bot', encryptionKey);
        const payload = _botEncrypt({ encryptedContent, encryptedName }, this.sharedKey);
        await _request(
            this.serverUrl,
            'POST',
            `/bot/${this.botId}/send-to-chat/${encodeURIComponent(chatHandle)}`,
            payload,
            { 'Authorization': await this._getAuthHeader(), 'Content-Type': 'text/plain' }
        );
    }

    /**
     * Send a rich message (with glass buttons) to a regular chat the bot has joined.
     * @param {string} chatHandle
     * @param {string} content
     * @param {Array<{label:string,value:string}>|RichContent} richContent
     * @param {string} encryptionKey
     */
    async sendRichToChat(chatHandle, content, richContent, encryptionKey, replyTo) {
        const rc = Array.isArray(richContent) ? { buttons: richContent } : (richContent || {});
        const encryptedContent = _encryptWithChatKey(content, encryptionKey);
        const encryptedName = _encryptWithChatKey(this._botName || 'Bot', encryptionKey);
        const encryptedRichContent = _encryptWithChatKey(JSON.stringify(rc), encryptionKey);
        const payloadObj = { encryptedContent, encryptedName, encryptedRichContent };
        if (replyTo && replyTo.messageId) {
            payloadObj.replyTo = {
                messageId: replyTo.messageId,
                encryptedPreview: _encryptWithChatKey(String(replyTo.preview || '').slice(0, 80), encryptionKey),
                encryptedSenderName: _encryptWithChatKey(String(replyTo.senderName || ''), encryptionKey),
            };
        }
        const payload = _botEncrypt(payloadObj, this.sharedKey);
        await _request(
            this.serverUrl,
            'POST',
            `/bot/${this.botId}/send-to-chat/${encodeURIComponent(chatHandle)}`,
            payload,
            { 'Authorization': await this._getAuthHeader(), 'Content-Type': 'text/plain' }
        );
    }

    /**
     * Fetch conversation history with a user.
     * @param {string} userId
     * @param {string} [afterId]
     * @returns {Promise<Array<{ id, role, content, ts }>>}
     */
    async getConversation(userId, afterId) {
        const qs = afterId ? `?after=${afterId}` : '';
        // Note: getConversation requires impersonating the user — not available to bots.
        // Bots use the inbox. This method is for reference.
        throw new Error('getConversation is not available to bots. Use the inbox.');
    }

    // ── Internals ──────────────────────────────────────────────────────────

    async _loadOrGenerateKeys() {
        if (this._privateKey && this._publicKeyRaw) return;

        if (fs.existsSync(this.keysFile)) {
            try {
                const saved = JSON.parse(fs.readFileSync(this.keysFile, 'utf8'));
                const privDer = Buffer.from(saved.privateKey, 'base64');
                this._privateKey = crypto.createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
                this._publicKeyRaw = Buffer.from(saved.publicKey, 'base64');
                this.botId = saved.botId;
                if (saved.name) this._botName = saved.name;
                if (saved.ecdhPrivateKey) {
                    this._ecdhPrivKey = Buffer.from(saved.ecdhPrivateKey, 'base64');
                    this._ecdhPubKeyRaw = Buffer.from(saved.ecdhPublicKey, 'base64');
                } else {
                    // Existing bot without P-256 ECDH keys — generate and save
                    this._generateECDHKeys();
                    const existing = JSON.parse(fs.readFileSync(this.keysFile, 'utf8'));
                    existing.ecdhPrivateKey = this._ecdhPrivKey.toString('base64');
                    existing.ecdhPublicKey = this._ecdhPubKeyRaw.toString('base64');
                    fs.writeFileSync(this.keysFile, JSON.stringify(existing, null, 2));
                }
                console.log(`[BotClient] Loaded keys from ${this.keysFile}. botId: ${this.botId}`);
                return;
            } catch (e) {
                console.warn(`[BotClient] Failed to load keys from ${this.keysFile}, regenerating:`, e.message);
            }
        }

        // Generate new Ed25519 + X25519 key pairs
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
        const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
        const pubSpkiDer = publicKey.export({ type: 'spki', format: 'der' });
        const rawPub = _rawPublicKeyFromDer(pubSpkiDer);
        const botId = crypto.createHash('sha256').update(rawPub).digest('hex');

        this._privateKey = privateKey;
        this._publicKeyRaw = rawPub;
        this.botId = botId;
        this._generateECDHKeys();

        fs.writeFileSync(this.keysFile, JSON.stringify({
            botId,
            publicKey: rawPub.toString('base64'),
            privateKey: privDer.toString('base64'),
            ecdhPublicKey: this._ecdhPubKeyRaw.toString('base64'),
            ecdhPrivateKey: this._ecdhPrivKey.toString('base64'),
        }, null, 2));
        console.log(`[BotClient] Generated new keys. botId: ${botId}`);
    }

    _generateECDHKeys() {
        const ecdh = crypto.createECDH('prime256v1');
        ecdh.generateKeys();
        this._ecdhPrivKey = ecdh.getPrivateKey();       // 32 bytes
        this._ecdhPubKeyRaw = ecdh.getPublicKey();      // 65 bytes uncompressed
    }

    _ecdhDecrypt(encryptedKeyBlob, ephemeralPubKeyBase64) {
        const ecdh = crypto.createECDH('prime256v1');
        ecdh.setPrivateKey(this._ecdhPrivKey);
        const ephemeralPubKeyBytes = Buffer.from(ephemeralPubKeyBase64, 'base64');
        const sharedSecret = ecdh.computeSecret(ephemeralPubKeyBytes); // 32 bytes (x-coord)
        const data = Buffer.from(encryptedKeyBlob, 'base64');
        const iv = data.slice(0, 12);
        const tag = data.slice(-16);
        const enc = data.slice(12, -16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', sharedSecret, iv);
        decipher.setAuthTag(tag);
        let dec = decipher.update(enc, 'binary', 'utf8');
        dec += decipher.final('utf8');
        return dec;
    }

    async _getAuthHeader() {
        const now = Date.now();
        const timeBucket = now - (now % 5000);
        const sig = crypto.sign(null, Buffer.from(timeBucket.toString()), this._privateKey);
        return `${this.botId}:${this._publicKeyRaw.toString('base64')}:${sig.toString('base64')}`;
    }

    _schedulePoll() {
        if (!this._running) return;
        this._pollTimer = setTimeout(async () => {
            try { await this._pollInbox(); } catch (e) { this._errorHandler(e); }
            this._schedulePoll();
        }, this.pollInterval);
    }

    _loadState() {
        try {
            if (fs.existsSync(this.stateFile)) {
                const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
                this._lastInboxId = s.lastInboxId || null;
            }
        } catch (e) {}
    }

    _saveState() {
        try {
            fs.writeFileSync(this.stateFile, JSON.stringify({ lastInboxId: this._lastInboxId }));
        } catch (e) {}
    }

    async _pollInbox() {
        const qs = this._lastInboxId ? `?after=${encodeURIComponent(this._lastInboxId)}` : '';
        const result = await _request(
            this.serverUrl,
            'GET',
            `/bot/${this.botId}/inbox${qs}`,
            null,
            { 'Authorization': await this._getAuthHeader() }
        );
        if (!result.encrypted) return;
        const { messages } = _botDecrypt(result.encrypted, this.sharedKey);
        let changed = false;
        for (const msg of (messages || [])) {
            this._lastInboxId = msg.id;
            changed = true;
            if (msg.type === 'join') {
                try {
                    const encryptionKey = this._ecdhDecrypt(msg.encryptedKeyBlob, msg.ephemeralPubKey);
                    this._chatKeys.set(msg.chatHandle, encryptionKey);
                    if (this._joinHandler) await this._joinHandler(msg.chatHandle, encryptionKey);
                } catch (e) { this._errorHandler(e); }
            } else if (msg.type === 'leave') {
                try {
                    if (this._leaveHandler) await this._leaveHandler(msg.chatHandle);
                } catch (e) { this._errorHandler(e); }
            } else if (msg.type === 'chat_message' || msg.type === 'mention') {
                const handler = msg.type === 'mention'
                    ? (this._mentionHandler || this._chatMessageHandler)
                    : this._chatMessageHandler;
                if (handler) {
                    const encryptionKey = this._chatKeys.get(msg.chatHandle);
                    if (encryptionKey) {
                        try {
                            const content = _decryptWithChatKey(msg.message.encryptedContent, encryptionKey);
                            let senderName = msg.message.senderUserId;
                            try { senderName = _decryptWithChatKey(msg.message.encryptedName, encryptionKey); } catch {}
                            let replyTo = null;
                            if (msg.message.replyTo) {
                                replyTo = { messageId: msg.message.replyTo.messageId };
                                try { replyTo.preview = _decryptWithChatKey(msg.message.replyTo.encryptedPreview, encryptionKey); } catch {}
                                try { replyTo.senderName = _decryptWithChatKey(msg.message.replyTo.encryptedSenderName, encryptionKey); } catch {}
                            }
                            await handler(msg.chatHandle, content, msg.message.senderUserId, msg.message.id, replyTo, senderName);
                        } catch (e) { this._errorHandler(e); }
                    }
                }
            } else {
                // Direct bot message (no type)
                if (this._messageHandler) {
                    try { await this._messageHandler(msg.userId, msg.content, msg.id); }
                    catch (e) { this._errorHandler(e); }
                }
            }
        }
        if (changed) this._saveState();
    }
}

module.exports = { BotClient };
