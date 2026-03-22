const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const Encryption = require('./encryption');
const crypto = require('crypto');
const PasswordLoader = require('./password-loader');
const AssetLoader = require('./asset-loader');

// ==================== LOGGING CONFIGURATION ====================
// P2P Transfer logging utility - detailed logs with status codes and flow information
function logP2PTransfer(operation, transferSessionId, status, details = {}) {
	const timestamp = new Date().toISOString();
	const statusCode = details.statusCode || '-';
	const chatHandle = details.chatHandle || '-';
	const fileName = details.fileName ? ` | File: ${details.fileName}` : '';
	const progress = details.progress ? ` | Progress: ${details.progress}` : '';
	const error = details.error ? ` | Error: ${details.error}` : '';
	const userId = details.userId ? ` | User: ${details.userId}` : '';
	const chunkInfo = details.chunkIndex !== undefined ? ` | Chunk: ${details.chunkIndex}/${details.totalChunks}` : '';
	
	console.log(`[P2P-TRANSFER] ${timestamp} | OP: ${operation} | SID: ${transferSessionId} | Status: ${status} | HTTP: ${statusCode} | Chat: ${chatHandle}${fileName}${progress}${error}${userId}${chunkInfo}`);
}

// Suppress general server logs
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

let suppressGeneral = false;
console.log = function(...args) {
	const message = args[0]?.toString() || '';
	// Always show P2P transfer logs, errors, and critical info
	if (message.includes('[P2P-TRANSFER]') || message.includes('❌') || message.includes('✅') || message.includes('Error') || message.includes('error') || message.includes('Shutting down')) {
		originalLog.apply(console, args);
	}
	// Suppress other general logs
};

console.warn = function(...args) {
	const message = args[0]?.toString() || '';
	if (message.includes('P2P') || message.includes('WARNING')) {
		originalWarn.apply(console, args);
	}
};

console.error = function(...args) {
	originalError.apply(console, args);
};

// ==================== CLIENT ERROR LOGGING ====================
const CLIENT_ERROR_LOG = path.join(__dirname, 'client-errors.log');

function decryptClientErrorPayload(encryptedBase64, keyStr) {
	// Pad key to 32 bytes — matches client padKey()
	const keyBytes = Buffer.alloc(32);
	const keyData = Buffer.from(keyStr, 'utf8');
	keyData.copy(keyBytes, 0, 0, Math.min(keyData.length, 32));

	const data = Buffer.from(encryptedBase64, 'base64');
	const iv = data.slice(0, 12);
	const authTag = data.slice(data.length - 16);
	const ciphertext = data.slice(12, data.length - 16);

	const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, iv);
	decipher.setAuthTag(authTag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function logClientError(entry) {
	const line = JSON.stringify(entry) + '\n';
	fs.appendFile(CLIENT_ERROR_LOG, line, (err) => {
		if (err) originalError('[ClientErrorLog] Failed to write:', err);
	});
}

// In-memory storage for messages (in production, use a database)
const messagesStorage = new Map();

// Rate limiting for /send endpoint
const sendRateLimits = new Map(); // `${userId}:${chatHandle}` -> { count, windowStart }
const RATE_LIMIT_WINDOW_MS = 10000;
const RATE_LIMIT_MAX = 15;
setInterval(() => {
	const now = Date.now();
	for (const [key, bucket] of sendRateLimits) {
		if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) sendRateLimits.delete(key);
	}
}, 60000);

// In-memory storage for message content (for deferred downloads)
// Structure: messageId -> { chatHandle, content, createdAt }
const messageContentStorage = new Map();

// In-memory storage for user heartbeats and online status
// Structure: chatHandle -> userId -> { lastHeartbeat, userName }
const userHeartbeats = new Map();
const lastKnownUsers = new Map(); // chatHandle → userId → {encryptedUserName, lastHeartbeat, lastMessageTime}

// In-memory storage for upload sessions
// Structure: sessionId -> { chatHandle, chunks: Map(chunkIndex -> data), totalChunks, createdAt, messageType, isCompressed }
const uploadSessions = new Map();

// In-memory storage for message metadata including compression flag
// Structure: messageId -> { isCompressed }
const messageMetadata = new Map();

// ==================== P2P TRANSFER STORAGE ====================
// In-memory storage for P2P transfer sessions
// Structure: transferSessionId -> TransferSession
const p2pTransfers = new Map();

// In-memory storage for pending transfer invitations
// Structure: chatHandle -> [Invitation] (simplified - all transfers in a chat are accessible)
const transferInvitations = new Map();

const SERVER_BUILD_ID = Date.now().toString();

// ==================== VOICE CALL STORAGE ====================
const activeCalls = new Map();       // callSessionId -> CallSession
const callAudioBuffers = new Map();  // callSessionId -> Map<userId, { chunks: [], seq: 0, initChunk: null }>
const callVideoBuffers = new Map();  // callSessionId -> Map<userId, { chunks: [], seq: 0, initChunk: null }>
const pendingCalls = new Map();      // chatHandle -> callSessionId

// Voice call constants
const CALL_RING_TIMEOUT = 30000;     // 30s to answer
const CALL_MAX_DURATION = 7200000;   // 2h max
const CALL_AUDIO_BUFFER_SIZE = 20;   // Keep last 20 chunks per user (circular)
const CALL_VIDEO_BUFFER_SIZE = 50;   // Keep last 50 video chunks per user (circular)
const CALL_MAX_PARTICIPANTS = 10;    // Max participants per call
const CALL_HEARTBEAT_TIMEOUT = 30000; // Evict participant after 30s without heartbeat

// P2P Transfer constants
const P2P_CHUNK_SIZE = 256 * 1024; // 256KB
const P2P_ACK_TIMEOUT = 10000; // 10 seconds
const P2P_MAX_RETRIES = 3;
const P2P_MAX_CONCURRENT = 2;
const P2P_INVITATION_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours
const P2P_TRANSFER_EXPIRY = 60 * 60 * 1000; // 1 hour for incomplete transfers

// Grace period for marking users as offline (in milliseconds)
const OFFLINE_GRACE_PERIOD = 30000; // 30 seconds
const OFFLINE_THRESHOLD = 15000; // 15 seconds before grace period

// Upload session timeout (5 minutes)
const UPLOAD_SESSION_TIMEOUT = 5 * 60 * 1000;

// Persistent message storage on disk
const DATA_DIR = path.join(__dirname, 'data');
const MAX_DISK_BYTES = 1024 * 1024 * 1024; // 1 GB
const EVICT_BATCH = 200;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Persistent seen positions: chatHandle -> Map(userId -> { lastReadId, encryptedUserName })
const seenPositions = new Map();
const SEEN_FILE = path.join(DATA_DIR, '_seen.json');

// Per-chat Ed25519 key pairs for password-locking chats
const chatKeysStorage = new Map(); // handle → { chatPublicKey, encryptedChatPrivateKey }
const CHAT_KEYS_FILE = path.join(DATA_DIR, '_chatkeys.json');

function loadChatKeys() {
	try {
		if (!fs.existsSync(CHAT_KEYS_FILE)) return;
		const obj = JSON.parse(fs.readFileSync(CHAT_KEYS_FILE, 'utf8'));
		for (const [handle, data] of Object.entries(obj)) chatKeysStorage.set(handle, data);
		originalLog(`[ChatKeys] Loaded keys for ${chatKeysStorage.size} chat(s)`);
	} catch (e) {
		originalError('[ChatKeys] Failed to load chat keys:', e);
	}
}

function saveChatKeys() {
	try {
		const obj = {};
		for (const [handle, data] of chatKeysStorage.entries()) obj[handle] = data;
		fs.writeFileSync(CHAT_KEYS_FILE, JSON.stringify(obj));
	} catch (e) {
		originalError('[ChatKeys] Failed to save chat keys:', e);
	}
}

function verifyChatSignature(handle, encryptedTimestampBase64, signatureBase64) {
	const keyData = chatKeysStorage.get(handle);
	if (!keyData) return true; // not locked yet — backward compat
	if (!signatureBase64) return false;
	try {
		const pubKeyBytes = Buffer.from(keyData.chatPublicKey, 'base64');
		const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
		const spkiDer = Buffer.concat([spkiHeader, pubKeyBytes]);
		const publicKey = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
		const data = Buffer.from(encryptedTimestampBase64, 'base64');
		const sig = Buffer.from(signatureBase64, 'base64');
		return crypto.verify(null, data, publicKey, sig);
	} catch (e) {
		return false;
	}
}

// ==================== BOT SYSTEM STORAGE ====================
const botsRegistry = new Map(); // botId (or 'pending:hash') -> bot record
const botConversations = new Map(); // `${botId}:${userId}` -> Message[]
const pendingBotMessages = new Map(); // botId -> Message[]
const botLastSeen = new Map(); // botId -> timestamp (updated on every /inbox or /reply)
const botChatMemberships = new Map(); // `${botId}:${chatHandle}` -> { botId, chatHandle, encryptedKeyBlob, ephemeralPubKey }
const botTypingState = new Map();    // `${botId}:${chatHandle}` -> { name, ts }
const BOT_TYPING_TTL = 6000;
const BOTS_FILE = path.join(DATA_DIR, '_bots.json');
const BOT_CONVS_FILE = path.join(DATA_DIR, '_botconvs.ndjson');
const BOT_MEMBERS_FILE = path.join(DATA_DIR, '_botmembers.json');

function loadBotMemberships() {
	try {
		if (!fs.existsSync(BOT_MEMBERS_FILE)) return;
		const arr = JSON.parse(fs.readFileSync(BOT_MEMBERS_FILE, 'utf8'));
		for (const m of arr) botChatMemberships.set(`${m.botId}:${m.chatHandle}`, m);
		originalLog(`[Bots] Loaded ${botChatMemberships.size} chat membership(s)`);
	} catch (e) { originalError('[Bots] Failed to load memberships:', e); }
}

function saveBotMemberships() {
	try {
		fs.writeFileSync(BOT_MEMBERS_FILE, JSON.stringify([...botChatMemberships.values()]));
	} catch (e) { originalError('[Bots] Failed to save memberships:', e); }
}

function loadBots() {
	try {
		if (!fs.existsSync(BOTS_FILE)) return;
		const arr = JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
		for (const bot of arr) botsRegistry.set(bot.botId || bot.pendingId, bot);
		originalLog(`[Bots] Loaded ${botsRegistry.size} bot(s)`);
	} catch (e) { originalError('[Bots] Failed to load:', e); }
}

function saveBots() {
	try {
		fs.writeFileSync(BOTS_FILE, JSON.stringify([...botsRegistry.values()]));
	} catch (e) { originalError('[Bots] Failed to save:', e); }
}

function loadBotConversations() {
	try {
		if (!fs.existsSync(BOT_CONVS_FILE)) return;
		const lines = fs.readFileSync(BOT_CONVS_FILE, 'utf8').split('\n').filter(Boolean);
		for (const line of lines) {
			const { key, msg } = JSON.parse(line);
			if (!botConversations.has(key)) botConversations.set(key, []);
			botConversations.get(key).push(msg);
		}
		originalLog(`[Bots] Loaded conversations for ${botConversations.size} thread(s)`);
	} catch (e) { originalError('[Bots] Failed to load conversations:', e); }
}

function appendBotConvToDisk(key, msg) {
	try { fs.appendFileSync(BOT_CONVS_FILE, JSON.stringify({ key, msg }) + '\n'); } catch (e) {}
}

function botEncrypt(obj, sharedKeyHex) {
	const key = Buffer.from(sharedKeyHex, 'hex');
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	let enc = cipher.update(JSON.stringify(obj), 'utf8', 'binary');
	enc += cipher.final('binary');
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, Buffer.from(enc, 'binary'), tag]).toString('base64');
}

function botDecrypt(base64, sharedKeyHex) {
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

function verifyBotAuth(req) {
	if (!handleVerify(req)) return null;
	const [userId] = (req.headers.authorization || '').split(':');
	const bot = botsRegistry.get(userId);
	return (bot && bot.activated) ? bot : null;
}

function loadSeenPositions() {
	try {
		if (!fs.existsSync(SEEN_FILE)) return;
		const obj = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
		for (const [chatHandle, userObj] of Object.entries(obj)) {
			const userMap = new Map();
			for (const [uid, data] of Object.entries(userObj)) userMap.set(uid, data);
			seenPositions.set(chatHandle, userMap);
		}
		originalLog(`[Seen] Loaded seen positions for ${seenPositions.size} chat(s)`);
	} catch (e) {
		originalError('[Seen] Failed to load seen positions:', e);
	}
}

function saveSeenPositions() {
	try {
		const obj = {};
		for (const [chatHandle, userMap] of seenPositions.entries()) {
			obj[chatHandle] = {};
			for (const [uid, data] of userMap.entries()) obj[chatHandle][uid] = data;
		}
		fs.writeFileSync(SEEN_FILE, JSON.stringify(obj));
	} catch (e) {
		originalError('[Seen] Failed to save seen positions:', e);
	}
}

// Cleanup old upload sessions periodically
setInterval(() => {
	const now = Date.now();
	for (const [sessionId, session] of uploadSessions.entries()) {
		if (now - session.createdAt > UPLOAD_SESSION_TIMEOUT) {
			console.log(`Cleaning up expired upload session: ${sessionId}`);
			uploadSessions.delete(sessionId);
		}
	}
}, 60000); // Check every 60 seconds

// Cleanup old P2P transfers periodically (every 5 minutes)
setInterval(() => {
const now = Date.now();

// Clean up expired invitations in each chat
for (const [chatHandle, invitations] of transferInvitations.entries()) {
	const activeInvitations = invitations.filter(inv => {
		if (now - inv.createdAt > P2P_INVITATION_EXPIRY) {
			console.log(`Cleaning up expired P2P invitation: ${inv.transferSessionId}`);
			return false;
		}
		return true;
	});
	
	if (activeInvitations.length === 0) {
		transferInvitations.delete(chatHandle);
	} else {
		transferInvitations.set(chatHandle, activeInvitations);
	}
}

// Clean up expired/incomplete transfers
for (const [transferSessionId, transfer] of p2pTransfers.entries()) {
	const age = now - transfer.createdAt;
	
	if (transfer.status === 'PENDING' && age > P2P_INVITATION_EXPIRY) {
		console.log(`Cleaning up expired P2P transfer: ${transferSessionId}`);
		cleanupP2PTransfer(transferSessionId);
	} else if (transfer.status !== 'COMPLETED' && age > P2P_TRANSFER_EXPIRY) {
		console.log(`Cleaning up incomplete P2P transfer: ${transferSessionId}`);
		transfer.status = 'FAILED';
		cleanupP2PTransfer(transferSessionId);
	}
}
}, 5 * 60 * 1000);

// Cleanup voice calls periodically (every 10 seconds)
setInterval(() => {
	const now = Date.now();
	for (const [callId, call] of activeCalls.entries()) {
		if (call.status === 'RINGING' && now - call.createdAt > CALL_RING_TIMEOUT) {
			call.status = 'ENDED';
			call.endedAt = now;
			pendingCalls.delete(call.chatHandle);
		} else if (call.status === 'ACTIVE') {
			if (now - call.startedAt > CALL_MAX_DURATION) {
				call.status = 'ENDED';
				call.endedAt = now;
				pendingCalls.delete(call.chatHandle);
			} else {
				// Evict participants with stale heartbeats
				const stale = call.participants.filter(uid => {
					const last = call.lastHeartbeat.get(uid);
					return last === undefined || (now - last) > CALL_HEARTBEAT_TIMEOUT;
				});
				for (const uid of stale) {
					call.participants = call.participants.filter(p => p !== uid);
					call.lastHeartbeat.delete(uid);
					const buffers = callAudioBuffers.get(callId);
					if (buffers) buffers.delete(uid);
					const vBuffers = callVideoBuffers.get(callId);
					if (vBuffers) vBuffers.delete(uid);
					if (call.videoParticipants) call.videoParticipants = call.videoParticipants.filter(p => p !== uid);
					console.log(`[CALL] Evicted stale participant ${uid} from call ${callId}`);
				}
				if (call.participants.length === 0) {
					call.status = 'ENDED';
					call.endedAt = now;
					pendingCalls.delete(call.chatHandle);
				}
			}
		} else if (call.status === 'ENDED' && now - call.endedAt > 30000) {
			activeCalls.delete(callId);
			callAudioBuffers.delete(callId);
			callVideoBuffers.delete(callId);
			pendingCalls.delete(call.chatHandle);
		}
	}
}, 10000);

// ==================== P2P HELPER FUNCTIONS ====================

function cleanupP2PTransfer(transferSessionId) {
	const transfer = p2pTransfers.get(transferSessionId);
	if (transfer) {
		// Clear chunk queue
		if (transfer.chunks) {
			transfer.chunks.clear();
		}
		
		// Remove from storage
		p2pTransfers.delete(transferSessionId);
		
		console.log(`Cleaned up P2P transfer: ${transferSessionId}`);
	}
}

function getP2PTransferCounts(userId) {
	let sending = 0;
	let receiving = 0;
	
	for (const transfer of p2pTransfers.values()) {
		if (transfer.status === 'COMPLETED' || transfer.status === 'FAILED') continue;
		
		if (transfer.senderId === userId) {
			sending++;
		}
		// Count receiving transfers: any transfer the user is actively receiving
		// (not the sender, and in TRANSFERRING state)
		if (transfer.senderId !== userId &&
		    ['ACCEPTED', 'TRANSFERRING'].includes(transfer.status)) {
			receiving++;
		}
	}
	
	return { sending, receiving };
}

// Load password from external .passwd file
const SERVER_PASSWRD = PasswordLoader.loadPassword();

if (!SERVER_PASSWRD) {
	console.error('❌ Failed to load password from .passwd file. Please create a .passwd file in the application directory.');
	console.error('   To create the password file, run: echo "your-password" > .passwd');
	process.exit(1);
}

console.log('✅ Password loaded successfully from external file');

// ==================== CHANNELS / ADMIN ====================

function _getChannelBasePath() {
	try { if (require('node:sea').isSea()) return path.dirname(process.execPath); } catch (_) {}
	return __dirname;
}

function loadAdminUserId() {
	try {
		const adminPath = path.join(_getChannelBasePath(), '.admin');
		if (fs.existsSync(adminPath)) return fs.readFileSync(adminPath, 'utf8').trim() || null;
	} catch (_) {}
	return null;
}

const CHANNEL_ADMIN_ID = loadAdminUserId();
if (CHANNEL_ADMIN_ID) console.log('✅ Channel admin loaded');
else console.warn('⚠️  No .admin file — System News channel has no admin');

const CHANNELS = [
	{ handle: 'system-news', displayName: 'System News', type: 'broadcast', adminUserId: CHANNEL_ADMIN_ID, pinned: true },
];
const CHANNEL_MAP = new Map(CHANNELS.map(c => [c.handle, c]));

// Per-message view counts: messageId → Set<userId>
const channelViewCounts = new Map();

// HMAC-signed build ID: clients verify this to prevent forged reload headers
const _buildHmac = crypto.createHmac('sha256', SERVER_PASSWRD).update(SERVER_BUILD_ID).digest('base64');
const SERVER_BUILD_HEADER = `${SERVER_BUILD_ID}.${_buildHmac}`;

// Load TLS certificates from assets directory (for binary) or cert directory (for development)
let certDir = path.join(__dirname, 'assets', 'cert');
if (!fs.existsSync(certDir)) {
	certDir = path.join(__dirname, 'cert');
}

const tlsOptions = {
	key: fs.readFileSync(path.join(certDir, 'key.pem')),
	cert: fs.readFileSync(path.join(certDir, 'cert.pem')),
};

const encryption = new Encryption();

// Create HTTP server
const server = https.createServer(tlsOptions, (req, res) => {
	try {
	// Inject build ID into every response for client-side reload detection
	const _wh = res.writeHead.bind(res);
	res.writeHead = (code, headers = {}) => { return _wh(code, {
		'X-Server-Build': SERVER_BUILD_HEADER,
		// CSP: restricts where resources can be loaded from, reducing XSS impact
		// unsafe-inline is required because scripts/styles are embedded in the HTML file
		'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' wss: https:; object-src 'none'; frame-ancestors 'none';",
		// Prevents browsers from MIME-sniffing responses away from declared content-type
		'X-Content-Type-Options': 'nosniff',
		// Blocks the page from being embedded in iframes (clickjacking protection)
		'X-Frame-Options': 'DENY',
		...headers
	}); };

	// Log all requests
	console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

	// Parse URL
	const parsedUrl = url.parse(req.url);
	const pathname = parsedUrl.pathname;

	// Public routes (no authentication required)
	if (pathname === '/') {
		console.log('Serving index.html');
		serveFile(res, 'index.html', 'text/html');
		return;
	}

	// /chat/login is also public - client-side validation handles auth
	if (pathname === '/chat/login') {
		console.log('Serving login.html');
		serveFile(res, 'login.html', 'text/html');
		return;
	}

	// Time sync endpoint - public, returns encrypted server time
	if (pathname === '/time-sync') {
		console.log('Handling GET /time-sync');
		handleTimeSync(req, res);
		return;
	}

	// PWA manifest - public
	if (pathname === '/manifest.json') {
		console.log('Serving manifest.json');
		serveFile(res, 'manifest.json', 'application/json');
		return;
	}

	// Service worker - public
	if (pathname === '/sw.js') {
		console.log('Serving sw.js');
		serveFile(res, 'sw.js', 'application/javascript');
		return;
	}

	// Serve static files (.js, .css, images) without authentication
	if (pathname.endsWith('.js') || pathname.endsWith('.css') ||
	    pathname.endsWith('.png') || pathname.endsWith('.jpg') ||
	    pathname.endsWith('.jpeg') || pathname.endsWith('.gif') ||
	    pathname.endsWith('.svg') || pathname.endsWith('.ico')) {
		const fileName = path.basename(pathname); // Extract filename from path
		const contentType = getMimeType(fileName);

		// Try to get from embedded assets first, then fall back to file system
		let assetData = AssetLoader.getAsset(fileName);

		if (!assetData) {
			// Check for icons in assets/icons directory
			if (pathname.startsWith('/icons/')) {
				const iconPath = path.join(__dirname, 'assets', 'icons', fileName);
				try {
					assetData = fs.readFileSync(iconPath);
					console.log(`Serving icon from assets/icons: ${fileName}`);
				} catch (err) {
					console.log(`Icon not found: ${fileName}`);
					res.writeHead(404, { 'Content-Type': 'text/plain' });
					res.end('Icon not found');
					return;
				}
			} else {
				// Fall back to file system for development
				const filePath = path.join(__dirname, fileName);
				try {
					assetData = fs.readFileSync(filePath);
				} catch (err) {
					console.log(`Static file not found: ${fileName}`);
					res.writeHead(404, { 'Content-Type': 'text/plain' });
					res.end('File not found');
					return;
				}
			}
		}

		console.log(`Serving static file: ${fileName}`);
		res.writeHead(200, { 'Content-Type': contentType });
		res.end(assetData);
		return;
	}

	// Verify endpoint - used for checking if credentials are valid

	if (req.method === 'GET' && pathname === '/verify') {
		// This endpoint requires authentication
		if (!handleVerify(req)) {
			res.writeHead(401, { 'Content-Type': 'text/plain' });
			res.end('unauthorized');
			return;
		}
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end('ok');
		return;
	}


	// Bot public routes (own auth mechanisms, not Ed25519)
	if (req.method === 'GET' && pathname === '/bots') {
		handleGetBots(req, res);
		return;
	}

	if (req.method === 'POST' && pathname === '/bots/activate') {
		handleBotActivate(req, res);
		return;
	}

	// All other routes require authentication
	if (!handleVerify(req)) {
		console.log('Authentication failed for:', pathname);
		res.writeHead(401, { 'Content-Type': 'text/plain' });
		res.end('unauthorized');
		return;
	}

	// Handle API routes (authenticated)
	if (req.method === 'POST' && pathname === '/client-error') {
		let body = '';
		req.on('data', chunk => { body += chunk; });
		req.on('end', () => {
			try {
				const decrypted = decryptClientErrorPayload(body.trim(), SERVER_PASSWRD);
				const data = JSON.parse(decrypted);
				const [userId] = (req.headers.authorization || '').split(':');
				logClientError({
					timestamp: new Date().toISOString(),
					userId: userId || 'unknown',
					type: data.type || 'error',
					message: data.message || '',
					source: data.source || '',
					lineno: data.lineno || null,
					colno: data.colno || null,
					stack: data.stack || null,
					url: data.url || '',
					userAgent: req.headers['user-agent'] || '',
					context: data.context || null,
				});
				res.writeHead(204);
				res.end();
			} catch (e) {
				originalError('[ClientErrorLog] Failed to decrypt/parse error report:', e.message);
				res.writeHead(400, { 'Content-Type': 'text/plain' });
				res.end('Bad Request');
			}
		});
		return;
	}

	if (req.method === 'GET' && pathname.startsWith('/messages/')) {
		console.log('Handling GET /messages/');
		handleGetMessages(req, res, pathname);
		return;
	}

	if (req.method === 'GET' && pathname.startsWith('/history/')) {
		handleGetHistory(req, res, pathname);
		return;
	}

	if (req.method === 'POST' && pathname.startsWith('/react/')) {
		handleReaction(req, res, pathname);
		return;
	}

	if (req.method === 'POST' && pathname.startsWith('/edit/')) {
		handleEditMessage(req, res, pathname);
		return;
	}

	if (req.method === 'POST' && pathname.startsWith('/send/')) {
		console.log('Handling POST /send/');
		handleSendMessage(req, res, pathname);
		return;
	}

	if (req.method === 'POST' && pathname.startsWith('/heartbeat/')) {
		console.log('Handling POST /heartbeat/');
		handleHeartbeat(req, res, pathname);
		return;
	}

	if (req.method === 'POST' && pathname.startsWith('/upload-chunk/')) {
		console.log('Handling POST /upload-chunk/');
		handleUploadChunk(req, res, pathname);
		return;
	}

	if (req.method === 'POST' && pathname.startsWith('/upload-complete/')) {
		console.log('Handling POST /upload-complete/');
		handleUploadComplete(req, res, pathname);
		return;
	}

	if (req.method === 'POST' && pathname.startsWith('/upload-cancel/')) {
		console.log('Handling POST /upload-cancel/');
		handleUploadCancel(req, res, pathname);
		return;
	}

	if (req.method === 'GET' && pathname.startsWith('/download-content/')) {
		console.log(`Handling GET /download-content/`);
		handleDownloadContent(req, res, pathname);
		return;
	}

	// ==================== P2P TRANSFER ENDPOINTS ====================

	// POST /transfer/initiate/{chatHandle} - Initiate a P2P file transfer
	if (req.method === 'POST' && pathname.startsWith('/transfer/initiate/')) {
		console.log('Handling POST /transfer/initiate/');
		handleTransferInitiate(req, res, pathname);
		return;
	}

	// GET /transfer/invitations/{chatHandle} - Get pending invitations for receiver
	if (req.method === 'GET' && pathname.startsWith('/transfer/invitations/')) {
		console.log('Handling GET /transfer/invitations/');
		handleTransferGetInvitations(req, res, pathname);
		return;
	}

	// POST /transfer/accept/{chatHandle}/{transferSessionId} - Accept a transfer invitation
	if (req.method === 'POST' && pathname.startsWith('/transfer/accept/')) {
		console.log('Handling POST /transfer/accept/');
		handleTransferAccept(req, res, pathname);
		return;
	}

	// POST /transfer/send-chunk/{chatHandle}/{transferSessionId} - Sender pushes a chunk
	if (req.method === 'POST' && pathname.startsWith('/transfer/send-chunk/')) {
		console.log('Handling POST /transfer/send-chunk/');
		handleTransferSendChunk(req, res, pathname);
		return;
	}

	// GET /transfer/receive-chunk/{chatHandle}/{transferSessionId} - Receiver polls for chunks with ACK
	if (req.method === 'GET' && pathname.startsWith('/transfer/receive-chunk/')) {
		console.log('Handling GET /transfer/receive-chunk/');
		handleTransferReceiveChunk(req, res, pathname);
		return;
	}

	// POST /transfer/complete/{chatHandle}/{transferSessionId} - Mark transfer as complete
	if (req.method === 'POST' && pathname.startsWith('/transfer/complete/')) {
		console.log('Handling POST /transfer/complete/');
		handleTransferComplete(req, res, pathname);
		return;
	}

	// GET /transfer/download/{chatHandle}/{transferSessionId} - Download assembled file
	if (req.method === 'GET' && pathname.startsWith('/transfer/download/')) {
		console.log('Handling GET /transfer/download/');
		handleTransferDownload(req, res, pathname);
		return;
	}

	// POST /transfer/cancel/{chatHandle}/{transferSessionId} - Cancel a transfer
	if (req.method === 'POST' && pathname.startsWith('/transfer/cancel/')) {
		console.log('Handling POST /transfer/cancel/');
		handleTransferCancel(req, res, pathname);
		return;
	}

	// GET /transfer/status/{chatHandle}/{transferSessionId} - Get transfer status
	if (req.method === 'GET' && pathname.startsWith('/transfer/status/')) {
		console.log('Handling GET /transfer/status/');
		handleTransferStatus(req, res, pathname);
		return;
	}

	// ==================== VOICE CALL ENDPOINTS ====================

	// POST /call/initiate/{chatHandle}
	if (req.method === 'POST' && pathname.startsWith('/call/initiate/')) {
		handleCallInitiate(req, res, pathname);
		return;
	}

	// GET /call/poll/{chatHandle}
	if (req.method === 'GET' && pathname.startsWith('/call/poll/')) {
		handleCallPoll(req, res, pathname);
		return;
	}

	// POST /call/join/{chatHandle}/{callId}
	if (req.method === 'POST' && pathname.startsWith('/call/join/')) {
		handleCallJoin(req, res, pathname);
		return;
	}

	// POST /call/reject/{chatHandle}/{callId}
	if (req.method === 'POST' && pathname.startsWith('/call/reject/')) {
		handleCallReject(req, res, pathname);
		return;
	}

	// POST /call/leave/{chatHandle}/{callId}
	if (req.method === 'POST' && pathname.startsWith('/call/leave/')) {
		handleCallLeave(req, res, pathname);
		return;
	}

	// POST /call/heartbeat/{chatHandle}/{callId}
	if (req.method === 'POST' && pathname.startsWith('/call/heartbeat/')) {
		handleCallHeartbeat(req, res, pathname);
		return;
	}

	// POST /call/audio/{chatHandle}/{callId}
	if (req.method === 'POST' && pathname.startsWith('/call/audio/')) {
		handleCallSendAudio(req, res, pathname);
		return;
	}

	// GET /call/audio/{chatHandle}/{callId}
	if (req.method === 'GET' && pathname.startsWith('/call/audio/')) {
		handleCallReceiveAudio(req, res, pathname);
		return;
	}

	// POST /call/video/{chatHandle}/{callId}
	if (req.method === 'POST' && pathname.startsWith('/call/video/')) {
		handleCallSendVideo(req, res, pathname);
		return;
	}

	// GET /call/video/{chatHandle}/{callId}
	if (req.method === 'GET' && pathname.startsWith('/call/video/')) {
		handleCallReceiveVideo(req, res, pathname);
		return;
	}

	// GET /channels
	if (req.method === 'GET' && pathname === '/channels') {
		handleGetChannels(req, res);
		return;
	}

	// POST /channels/:handle/view
	if (req.method === 'POST' && pathname.startsWith('/channels/') && pathname.endsWith('/view')) {
		handleChannelView(req, res, pathname);
		return;
	}

	// GET /chat/:handle/key
	if (req.method === 'GET' && pathname.startsWith('/chat/') && pathname.endsWith('/key')) {
		const handle = decodeURIComponent(pathname.split('/')[2]);
		const keyData = chatKeysStorage.get(handle);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(keyData
			? { chatPublicKey: keyData.chatPublicKey, encryptedChatPrivateKey: keyData.encryptedChatPrivateKey }
			: { chatPublicKey: null }
		));
		return;
	}

	// POST /chat/:handle/register-key
	if (req.method === 'POST' && pathname.startsWith('/chat/') && pathname.endsWith('/register-key')) {
		const handle = decodeURIComponent(pathname.split('/')[2]);
		const existing = chatKeysStorage.get(handle);
		if (existing) {
			res.writeHead(409, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ chatPublicKey: existing.chatPublicKey, encryptedChatPrivateKey: existing.encryptedChatPrivateKey }));
			return;
		}
		let body = '';
		req.on('data', chunk => { body += chunk; });
		req.on('end', () => {
			try {
				const { chatPublicKey, encryptedChatPrivateKey } = JSON.parse(body);
				if (!chatPublicKey || !encryptedChatPrivateKey) throw new Error('Missing fields');
				chatKeysStorage.set(handle, { chatPublicKey, encryptedChatPrivateKey });
				saveChatKeys();
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: true }));
			} catch (e) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid request' }));
			}
		});
		return;
	}

	// ==================== BOT ENDPOINTS ====================

	if (req.method === 'POST' && pathname === '/admin/bots') {
		handleAdminCreateBot(req, res);
		return;
	}

	if (req.method === 'DELETE' && pathname.startsWith('/admin/bots/')) {
		handleAdminDeleteBot(req, res, pathname);
		return;
	}

	if (req.method === 'POST' && pathname.startsWith('/bot/') && pathname.endsWith('/send')) {
		handleBotSend(req, res, pathname);
		return;
	}

	if (req.method === 'GET' && pathname.startsWith('/bot/') && pathname.endsWith('/messages')) {
		handleBotMessages(req, res, pathname);
		return;
	}

	if (req.method === 'GET' && pathname.startsWith('/bot/') && pathname.endsWith('/inbox')) {
		handleBotInbox(req, res, pathname);
		return;
	}

	if (req.method === 'POST' && pathname.startsWith('/bot/') && pathname.endsWith('/reply')) {
		handleBotReply(req, res, pathname);
		return;
	}

	if (req.method === 'POST' && pathname.startsWith('/bot/') && pathname.endsWith('/commands')) {
		handleBotSetCommands(req, res, pathname);
		return;
	}

	if (req.method === 'POST' && pathname.startsWith('/bot/') && pathname.includes('/join/')) {
		handleBotJoinChat(req, res, pathname);
		return;
	}

	if (req.method === 'DELETE' && pathname.startsWith('/bot/') && pathname.includes('/join/')) {
		handleBotLeaveChat(req, res, pathname);
		return;
	}

	if (req.method === 'POST' && pathname.startsWith('/bot/') && pathname.includes('/send-to-chat/')) {
		handleBotSendToChat(req, res, pathname);
		return;
	}

	if (req.method === 'POST' && pathname.startsWith('/bot/') && pathname.includes('/typing/')) {
		handleBotSetTyping(req, res, pathname);
		return;
	}

	if (req.method === 'GET' && pathname.startsWith('/chat/') && pathname.endsWith('/bots')) {
		handleGetChatBots(req, res, pathname);
		return;
	}

	// Default response
	console.log('404 Not Found');
	res.writeHead(404, { 'Content-Type': 'text/plain' });
	res.end('Not Found');
	} catch (err) {
		console.error(`[${new Date().toISOString()}] Unhandled request error for ${req.method} ${req.url}:`, err);
		if (!res.headersSent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Internal server error', detail: err.message }));
		}
	}
});

// ==================== DISK PERSISTENCE ====================

function chatToFilePath(chatHandle) {
	const hash = crypto.createHash('sha256').update(chatHandle).digest('hex');
	return path.join(DATA_DIR, hash + '.ndjson');
}

function appendMessageToDisk(chatHandle, message, content, isCompressed) {
	const entry = { h: chatHandle, msg: message, content: content || null, isCompressed: isCompressed || false };
	fs.appendFileSync(chatToFilePath(chatHandle), JSON.stringify(entry) + '\n');
	evictOldestIfOverQuota();
}

function appendReactionPatchToDisk(chatHandle, messageId, reactions, lastUpdated) {
	try {
		const entry = { h: chatHandle, type: 'reaction_patch', messageId, reactions, lastUpdated };
		fs.appendFileSync(chatToFilePath(chatHandle), JSON.stringify(entry) + '\n');
	} catch (e) {
		console.error('Failed to persist reaction patch:', e);
	}
}

function appendEditPatchToDisk(chatHandle, messageId, encryptedContent, edits, lastUpdated) {
	try {
		const entry = { h: chatHandle, type: 'edit_patch', messageId, encryptedContent, edits, lastUpdated };
		fs.appendFileSync(chatToFilePath(chatHandle), JSON.stringify(entry) + '\n');
	} catch (e) {
		console.error('Failed to persist edit patch:', e);
	}
}

function getTotalDataSizeBytes() {
	let total = 0;
	try {
		for (const f of fs.readdirSync(DATA_DIR)) {
			try { total += fs.statSync(path.join(DATA_DIR, f)).size; } catch (e) {}
		}
	} catch (e) {}
	return total;
}

function evictOldestIfOverQuota() {
	if (getTotalDataSizeBytes() <= MAX_DISK_BYTES) return;

	let oldestFile = null, oldestTs = Infinity;
	for (const f of fs.readdirSync(DATA_DIR)) {
		if (!f.endsWith('.ndjson')) continue;
		const fp = path.join(DATA_DIR, f);
		try {
			const fd = fs.openSync(fp, 'r');
			const buf = Buffer.alloc(8192);
			const n = fs.readSync(fd, buf, 0, 8192, 0);
			fs.closeSync(fd);
			const firstLine = buf.slice(0, n).toString('utf8').split('\n')[0];
			const entry = JSON.parse(firstLine);
			const ts = decryptTimestamp(entry.msg.encryptedTimestamp);
			if (ts < oldestTs) { oldestTs = ts; oldestFile = fp; }
		} catch (e) {}
	}

	if (!oldestFile) return;
	const lines = fs.readFileSync(oldestFile, 'utf8').split('\n').filter(l => l.trim());
	const trimmed = lines.slice(EVICT_BATCH);
	if (trimmed.length === 0) {
		fs.unlinkSync(oldestFile);
	} else {
		fs.writeFileSync(oldestFile, trimmed.join('\n') + '\n');
	}
}

function loadPersistentStorage() {
	try {
		const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.ndjson'));
		for (const file of files) {
			const fp = path.join(DATA_DIR, file);
			const rawLines = fs.readFileSync(fp, 'utf8').split('\n').filter(l => l.trim());
			if (rawLines.length === 0) continue;

			// Read chatHandle from first valid line
			let chatHandle;
			for (const line of rawLines) {
				try { chatHandle = JSON.parse(line).h; break; } catch (e) {}
			}
			if (!chatHandle) continue;

			// Two-pass: collect messages (Map deduplicates by id, preserving insertion order)
			// and collect patches (reactions + edits) to apply after.
			const messageMap = new Map(); // id → { msg, content, isCompressed }
			const patches = [];           // reaction_patch | edit_patch

			for (const line of rawLines) {
				try {
					const entry = JSON.parse(line);
					if (entry.type === 'reaction_patch' || entry.type === 'edit_patch') {
						patches.push(entry);
					} else if (entry.msg && entry.msg.id) {
						const existing = messageMap.get(entry.msg.id);
						messageMap.set(entry.msg.id, {
							msg: entry.msg,
							content: entry.content || (existing && existing.content) || null,
							isCompressed: entry.isCompressed || false
						});
					}
				} catch (e) {}
			}

			// Apply patches (reactions + edits) to their messages
			for (const patch of patches) {
				const entry = messageMap.get(patch.messageId);
				if (!entry) continue;
				if (patch.type === 'reaction_patch') {
					entry.msg.reactions = patch.reactions;
				} else if (patch.type === 'edit_patch') {
					entry.msg.encryptedContent = patch.encryptedContent;
					entry.msg.edits = patch.edits;
				}
				if (patch.lastUpdated) entry.msg.lastUpdated = patch.lastUpdated;
			}

			// Keep last 100 unique messages
			const entries = [...messageMap.values()].slice(-100);
			const messages = [];
			for (const entry of entries) {
				messages.push(entry.msg);
				if (entry.content) {
					messageContentStorage.set(`${chatHandle}:${entry.msg.id}`, entry.content);
				}
				if (entry.msg.id) {
					messageMetadata.set(entry.msg.id, { isCompressed: entry.isCompressed || false });
				}
			}
			messagesStorage.set(chatHandle, messages);
		}
		originalLog(`[Persistence] Loaded ${messagesStorage.size} chat(s) from disk`);
	} catch (e) {
		originalError('[Persistence] Failed to load from disk:', e);
	}
}

loadPersistentStorage();
loadSeenPositions();
loadChatKeys();
loadBots();
loadBotConversations();
loadBotMemberships();

function handleVerify(req) {
	const authorization = req.headers.authorization;
	if (!authorization) return false;

	// Header format: userId:base64(publicKey):base64(signature)
	// userId = SHA256(rawPublicKey), signature = Ed25519(timeBucket, privateKey)
	const parts = authorization.split(':');
	if (parts.length !== 3) return false;

	const [userId, publicKeyBase64, signatureBase64] = parts;

	// Verify userId is SHA256 of the public key (self-certifying identity)
	const rawPubKeyBytes = Buffer.from(publicKeyBase64, 'base64');
	const expectedUserId = crypto.createHash('sha256').update(rawPubKeyBytes).digest('hex');
	if (expectedUserId !== userId) {
		console.log(`❌ Auth failed: userId mismatch for claimed ${userId}`);
		return false;
	}

	// Import Ed25519 public key (wrap raw 32 bytes in SPKI DER envelope)
	const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
	const spkiDer = Buffer.concat([spkiHeader, rawPubKeyBytes]);
	let publicKey;
	try {
		publicKey = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
	} catch (e) {
		console.log(`❌ Auth failed: invalid public key for ${userId}`);
		return false;
	}

	const signatureBytes = Buffer.from(signatureBase64, 'base64');
	const now = Date.now();

	// Check 12 time buckets (60 seconds tolerance)
	for (let i = 0; i < 12; i++) {
		const timeBucket = now - (i * 5000) - (now % 5000);
		try {
			if (crypto.verify(null, Buffer.from(timeBucket.toString()), publicKey, signatureBytes)) {
				console.log(`✅ Authentication successful for userId: ${userId} (offset: ${i * 5000}ms)`);
				return true;
			}
		} catch (e) {}
	}

	console.log(`❌ Authentication failed for userId: ${userId}`);
	return false;
}

// Serialize a message for the wire: hides senderUserId, computes isMine for reactions
function serializeMessageForClient(message, requestingUserId) {
	const transformedReactions = {};
	for (const [encryptedEmoji, data] of Object.entries(message.reactions || {})) {
		transformedReactions[encryptedEmoji] = {
			count: data.userIds.length,
			isMine: data.userIds.includes(requestingUserId)
		};
	}
	const colorToken = crypto.createHash('sha256')
		.update((message.senderUserId || 'unknown') + requestingUserId)
		.digest('hex').slice(0, 16);
	const vcSet = channelViewCounts.get(message.id);
	return {
		id: message.id,
		encryptedName: message.encryptedName,
		encryptedContent: message.encryptedContent,
		encryptedTimestamp: message.encryptedTimestamp,
		type: message.type,
		keyFp: message.keyFp || null,
		stickerId: message.stickerId || null,
		replyTo: message.replyTo || null,
		isEdited: (message.edits || []).length > 0,
		reactions: transformedReactions,
		colorToken,
		viewCount: vcSet ? vcSet.size : null,
		encryptedRichContent: message.encryptedRichContent || null,
		isBot: !!(message.senderUserId && botsRegistry.get(message.senderUserId)?.activated),
	};
}

// Load messages from NDJSON disk file after a given timestamp (disk fallback for old cursors)
function loadMessagesFromDisk(chatHandle, afterTimestamp, limit) {
	const fp = chatToFilePath(chatHandle);
	if (!fs.existsSync(fp)) return { messages: [], gap: false };

	const rawLines = fs.readFileSync(fp, 'utf8').split('\n').filter(l => l.trim());
	const messageMap = new Map();
	const reactionPatches = [];

	const patches = []; // reaction + edit patches
	for (const line of rawLines) {
		try {
			const entry = JSON.parse(line);
			if (entry.type === 'reaction_patch' || entry.type === 'edit_patch') {
				patches.push(entry);
			} else if (entry.msg && entry.msg.id) {
				messageMap.set(entry.msg.id, entry);
			}
		} catch (e) {}
	}

	// Apply patches (reactions + edits)
	for (const patch of patches) {
		const entry = messageMap.get(patch.messageId);
		if (!entry) continue;
		if (patch.type === 'reaction_patch') {
			entry.msg.reactions = patch.reactions;
		} else if (patch.type === 'edit_patch') {
			entry.msg.encryptedContent = patch.encryptedContent;
			entry.msg.edits = patch.edits;
		}
		if (patch.lastUpdated) entry.msg.lastUpdated = patch.lastUpdated;
	}

	// Filter after timestamp
	const filtered = [...messageMap.values()].filter(e => {
		try {
			const t = decryptTimestamp(e.msg.encryptedTimestamp);
			return t > afterTimestamp || ((e.msg.lastUpdated || 0) > afterTimestamp);
		} catch { return false; }
	});

	// Sort and limit
	filtered.sort((a, b) => {
		try { return decryptTimestamp(a.msg.encryptedTimestamp) - decryptTimestamp(b.msg.encryptedTimestamp); }
		catch { return 0; }
	});

	const result = filtered.slice(0, limit);

	// Load content into memory for deferred downloads
	for (const entry of result) {
		if (entry.content) {
			const key = `${chatHandle}:${entry.msg.id}`;
			if (!messageContentStorage.has(key)) messageContentStorage.set(key, entry.content);
			if (entry.msg.id) messageMetadata.set(entry.msg.id, { isCompressed: entry.isCompressed || false });
		}
	}

	return { messages: result.map(e => e.msg), gap: false };
}

// Handle GET messages request
function handleGetMessages(req, res, pathname) {
	console.log(`GET messages request for path: ${pathname}`);

	// Extract chat handle from URL path
	// Format: /messages/chatHandle
	const parts = pathname.split('/');
	const chatHandle = parts[2]; // Get the third part after splitting by '/'

	if (!chatHandle) {
		console.log('Chat handle is required');
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle is required' }));
		return;
	}

	// ---- New code starts ----
	// Parse query string for `after` parameter
	const query = url.parse(req.url, true).query;
	const after = query.after; // e.g. "12345678-90ab-cdef-..."
	// ---------------------------------

	// Get all messages for this chat handle
	const allMessages = messagesStorage.get(chatHandle) || [];
	console.log(
		`Total stored messages for "${chatHandle}": ${allMessages.length}`,
	);

	// If an "after" id is provided, filter out earlier messages using chronological comparison
	let filteredMessages;
	let afterTimestamp = null;
	let gapDetected = false;
	if (after) {
		try {
			afterTimestamp = decryptTimestamp(after);

			// Check if cursor is older than oldest in-memory message
			let oldestInMemory = Infinity;
			for (const msg of allMessages) {
				try {
					const t = decryptTimestamp(msg.encryptedTimestamp);
					if (t < oldestInMemory) oldestInMemory = t;
				} catch {}
			}

			if (afterTimestamp < oldestInMemory && allMessages.length > 0) {
				// Cursor is older than memory window — fall back to disk
				const diskResult = loadMessagesFromDisk(chatHandle, afterTimestamp, 200);
				if (diskResult.messages.length > 0) {
					// Merge disk + memory, deduplicate by ID
					const merged = new Map();
					for (const m of diskResult.messages) merged.set(m.id, m);
					for (const m of allMessages) {
						try {
							if (decryptTimestamp(m.encryptedTimestamp) > afterTimestamp ||
								(m.lastUpdated || 0) > afterTimestamp) {
								merged.set(m.id, m);
							}
						} catch {}
					}
					filteredMessages = [...merged.values()];
				} else {
					// Disk also doesn't have it — signal gap to client
					gapDetected = true;
					filteredMessages = allMessages;
				}
			} else {
				// Normal path: cursor is within memory window
				filteredMessages = allMessages.filter((msg) => {
					try {
						const msgTimestamp = decryptTimestamp(msg.encryptedTimestamp);
						return msgTimestamp > afterTimestamp || ((msg.lastUpdated || 0) > afterTimestamp);
					} catch (err) {
						console.warn('Skipping message with invalid timestamp:', err);
						return false;
					}
				});
			}
			console.log(
				`Filtering after timestamp ${afterTimestamp}: ${filteredMessages.length} new messages${gapDetected ? ' (gap detected)' : ''}`,
			);
		} catch (err) {
			console.warn('Failed to decrypt after parameter, returning all messages:', err);
			filteredMessages = allMessages;
			afterTimestamp = null;
		}
	} else {
		filteredMessages = allMessages;
	}

	// Sort messages chronologically by decrypted timestamp
	filteredMessages.sort((a, b) => {
		try {
			const aTime = decryptTimestamp(a.encryptedTimestamp);
			const bTime = decryptTimestamp(b.encryptedTimestamp);
			return aTime - bTime;
		} catch (err) {
			console.warn('Sort error for messages:', err);
			return 0; // Keep relative order if decryption fails
		}
	});

	// Extract requesting userId for reaction isMine computation
	const authorization = req.headers.authorization || '';
	const [requestingUserId] = authorization.split(':');

	// Serialize messages; mark as isUpdate if original timestamp <= afterTimestamp (reaction/edit re-sends)
	const serializedMessages = filteredMessages.map(msg => {
		const s = serializeMessageForClient(msg, requestingUserId);
		if (afterTimestamp !== null) {
			try {
				if (decryptTimestamp(msg.encryptedTimestamp) <= afterTimestamp) s.isUpdate = true;
			} catch {}
		}
		return s;
	});

	// nextCursor = max(all timestamps + lastUpdated) so client cursor advances past updates too
	let nextCursor = null;
	if (filteredMessages.length > 0) {
		let maxTime = afterTimestamp || 0;
		filteredMessages.forEach(msg => {
			try {
				const t = decryptTimestamp(msg.encryptedTimestamp);
				if (t > maxTime) maxTime = t;
			} catch {}
			if ((msg.lastUpdated || 0) > maxTime) maxTime = msg.lastUpdated;
		});
		if (maxTime > 0) nextCursor = encryptTimestamp(maxTime);
	}

	// Send the (filtered and sorted) list, serialized for client
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ messages: serializedMessages, nextCursor, gap: gapDetected || false }));
}

// Generate UUID v4
function generateUUID() {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
		const r = Math.random() * 16 | 0;
		const v = c === 'x' ? r : (r & 0x3 | 0x8);
		return v.toString(16);
	});
}

// Handle POST send message request
function handleSendMessage(req, res, pathname) {
	console.log(`POST send request for path: ${pathname}`);

	// Extract chat handle from URL path
	// Format: /send/chatHandle
	const parts = pathname.split('/');
	const chatHandle = parts[2]; // <-- correct

	console.log(`Extracted chat handle: ${chatHandle}`);

	if (!chatHandle) {
		console.log('Chat handle is required');
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle is required' }));
		return;
	}

	let body = '';

	req.on('data', (chunk) => {
		body += chunk.toString();
		console.log(`Received chunk: ${chunk.toString().substring(0, 100)}...`);
	});

	req.on('end', () => {
		console.log('Request body received:');
		console.log(body);

		try {
			const messageData = JSON.parse(body);
			// messageData should now contain `encryptedName`, `content`, `encryptedTimestamp`, and `sender`

			// Decrypt the timestamp to verify it's valid (security check)
			try {
				decryptTimestamp(messageData.encryptedTimestamp);
			} catch (err) {
				console.warn('Failed to decrypt timestamp:', err);
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid encrypted timestamp' }));
				return;
			}

			// Extract userId for edit authorization
			const authorization = req.headers.authorization || '';
			const [senderUserId] = authorization.split(':');

			// Channel guard — only admin may post
			const sendChannel = CHANNEL_MAP.get(chatHandle);
			if (sendChannel && senderUserId !== sendChannel.adminUserId) {
				res.writeHead(403, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Not authorized to post in this channel' }));
				return;
			}

			// Chat key signature check (skipped for channels — already guarded by adminUserId)
			if (!sendChannel && !verifyChatSignature(chatHandle, messageData.encryptedTimestamp, messageData.chatSignature)) {
				res.writeHead(403, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid chat signature' }));
				return;
			}

			// Rate limit check
			const rateLimitKey = `${senderUserId}:${chatHandle}`;
			const now = Date.now();
			const bucket = sendRateLimits.get(rateLimitKey) || { count: 0, windowStart: now };
			if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) { bucket.count = 0; bucket.windowStart = now; }
			bucket.count++;
			sendRateLimits.set(rateLimitKey, bucket);
			if (bucket.count > RATE_LIMIT_MAX) {
				res.writeHead(429, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
				return;
			}

			// Create message object with encrypted timestamp as ID (secure and chronological)
			const messageId = messageData.encryptedTimestamp;
			const message = {
				encryptedName: messageData.encryptedName,
				encryptedContent: messageData.content,
				encryptedTimestamp: messageData.encryptedTimestamp,
				type: messageData.type || 'text',
				id: messageId,
				keyFp: messageData.keyFp || null,
				senderUserId,          // stored server-side only, never sent to clients
				reactions: {},         // encryptedEmoji → { userIds: [], encryptedUserNames: {} }
				edits: [],             // [{ encryptedEditTimestamp }]
				replyTo: messageData.replyTo || null, // { messageId, encryptedPreview, encryptedSenderName }
				richContent: messageData.richContent || null,
			};

			// Store message
			if (!messagesStorage.has(chatHandle)) {
				messagesStorage.set(chatHandle, []);
			}
			messagesStorage.get(chatHandle).push(message);
			console.log(`Stored message for chat handle: ${chatHandle} with ID: ${messageId}`);

			// Track last message time per user
			if (userHeartbeats.has(chatHandle)) {
				const cu = userHeartbeats.get(chatHandle).get(senderUserId);
				if (cu) cu.lastMessageTime = now;
			}

			// Forward ciphertext to bots in this chat
			const mentionedBotIds = Array.isArray(messageData.mentionedBotIds) ? messageData.mentionedBotIds : [];
			for (const [, membership] of botChatMemberships) {
				if (membership.chatHandle !== chatHandle) continue;
				if (membership.botId === senderUserId) continue; // no echo
				if (!pendingBotMessages.has(membership.botId)) pendingBotMessages.set(membership.botId, []);
				pendingBotMessages.get(membership.botId).push({
					id: message.id,
					type: mentionedBotIds.includes(membership.botId) ? 'mention' : 'chat_message',
					chatHandle,
					message: {
						id: message.id,
						encryptedContent: message.encryptedContent,
						encryptedName: message.encryptedName,
						senderUserId: message.senderUserId,
					},
					ts: Date.now(),
				});
			}

			// Persist to disk
			appendMessageToDisk(chatHandle, message, messageData.content, false);

			// Store encrypted content for deferred downloads
			const contentKey = `${chatHandle}:${messageId}`;
			messageContentStorage.set(contentKey, messageData.content);
			console.log(`Cached content for message ${messageId}`);

			// Keep only last 100 messages
			const chatMessages = messagesStorage.get(chatHandle);
			if (chatMessages.length > 100) {
				const removedMsg = chatMessages.shift();
				// Also remove from content storage
				const oldContentKey = `${chatHandle}:${removedMsg.id}`;
				messageContentStorage.delete(oldContentKey);
				console.log(`Trimmed messages for chat handle: ${chatHandle}`);
			}

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true, messageId: messageId }));
			console.log('Message sent successfully');
		} catch (error) {
			console.error('Error parsing message data:', error);
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid message data' }));
		}
	});
}

// Handle heartbeat request
function handleHeartbeat(req, res, pathname) {
	console.log(`POST heartbeat request for path: ${pathname}`);

	// Extract chat handle and userId from Authorization header
	const authorization = req.headers.authorization;
	if (!authorization) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Missing authorization' }));
		return;
	}

	const [userId] = authorization.split(':');
	const parts = pathname.split('/');
	const chatHandle = parts[2];

	if (!chatHandle) {
		console.log('Chat handle is required');
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle is required' }));
		return;
	}

	// Channels have no presence — return immediately to prevent viewer exposure
	if (CHANNEL_MAP.has(chatHandle)) {
		req.resume();
		res.writeHead(204);
		res.end();
		return;
	}

	let body = '';

	req.on('data', (chunk) => {
		body += chunk.toString();
	});

	req.on('end', () => {
		try {
			const heartbeatData = JSON.parse(body);
			const { encryptedUserName, encryptedTyping, lastReadId } = heartbeatData;

			const now = Date.now();

			// Initialize chat entry if needed
			if (!userHeartbeats.has(chatHandle)) {
				userHeartbeats.set(chatHandle, new Map());
			}

			const chatUsers = userHeartbeats.get(chatHandle);

			// Clean up expired heartbeats (grace period passed), preserve in lastKnownUsers
			for (const [uid, userData] of chatUsers.entries()) {
				if (now - userData.lastHeartbeat > OFFLINE_GRACE_PERIOD) {
					if (!lastKnownUsers.has(chatHandle)) lastKnownUsers.set(chatHandle, new Map());
					lastKnownUsers.get(chatHandle).set(uid, {
						encryptedUserName: userData.encryptedUserName,
						lastHeartbeat: userData.lastHeartbeat,
						lastMessageTime: userData.lastMessageTime || 0
					});
					chatUsers.delete(uid);
					console.log(`Removed offline user ${uid} from chat ${chatHandle}`);
				}
			}

			// Decrypt encryptedTyping — numeric state: 0=idle,1=typing,2=recording,3=uploading
			let typingState = 0;
			if (encryptedTyping) {
				try { typingState = decryptTimestamp(encryptedTyping); } catch (e) {}
			}

			const prevUser = chatUsers.get(userId);

			// Restore persisted lastReadId if user reconnects without sending one
			const persistedSeen = seenPositions.get(chatHandle);
			const persistedReadId = persistedSeen?.get(userId)?.lastReadId || '';
			const resolvedReadId = lastReadId || prevUser?.lastReadId || persistedReadId;

			// Update the current user's heartbeat
			chatUsers.set(userId, {
				lastHeartbeat: now,
				encryptedUserName: encryptedUserName || 'Unknown',
				typingState,
				lastTypingTime: typingState > 0 ? now : (prevUser?.lastTypingTime || 0),
				lastReadId: resolvedReadId
			});

			// Persist seen position when lastReadId advances
			if (lastReadId && lastReadId !== persistedSeen?.get(userId)?.lastReadId) {
				if (!seenPositions.has(chatHandle)) seenPositions.set(chatHandle, new Map());
				seenPositions.get(chatHandle).set(userId, { lastReadId, encryptedUserName: encryptedUserName || 'Unknown' });
				saveSeenPositions();
			}

			console.log(`Heartbeat from ${userId} (${encryptedUserName}) in chat ${chatHandle}`);

			// Build online users header — live users first, then offline known users
			const onlineUsersArray = Array.from(chatUsers.entries()).map(([uid, userData]) => {
				const timeSinceHeartbeat = now - userData.lastHeartbeat;
				const isOnline = timeSinceHeartbeat <= OFFLINE_THRESHOLD;
				const typingActive = userData.typingState > 0 && (now - (userData.lastTypingTime || 0)) < 5000;

				const encStatus = encryptTimestamp(isOnline ? 1 : 0);
				const encTyping = encryptTimestamp(typingActive ? userData.typingState : 0);
				const encLastSeen = encryptTimestamp(userData.lastHeartbeat);
				const encLastMessage = encryptTimestamp(userData.lastMessageTime || 0);

				return `${userData.encryptedUserName}|${encStatus}|${encTyping}|${encLastSeen}|${encLastMessage}`;
			});

			// Append offline known users (not currently in chatUsers)
			const knownForChat = lastKnownUsers.get(chatHandle);
			if (knownForChat) {
				for (const [uid, kd] of knownForChat.entries()) {
					if (!chatUsers.has(uid)) {
						const encStatus = encryptTimestamp(0);
						const encTyping = encryptTimestamp(0);
						const encLastSeen = encryptTimestamp(kd.lastHeartbeat);
						const encLastMessage = encryptTimestamp(kd.lastMessageTime || 0);
						onlineUsersArray.push(`${kd.encryptedUserName}|${encStatus}|${encTyping}|${encLastSeen}|${encLastMessage}`);
					}
				}
			}

			const onlineUsersHeader = onlineUsersArray.join(',');

			console.log(`Online users in ${chatHandle}: ${onlineUsersHeader}`);

			// Build read receipts: merge persisted (offline users) with current online users
			// Persisted data is the base; online users override with latest values
			const mergedSeen = new Map(seenPositions.get(chatHandle) || []);
			for (const [uid, userData] of chatUsers.entries()) {
				if (userData.lastReadId) {
					mergedSeen.set(uid, { lastReadId: userData.lastReadId, encryptedUserName: userData.encryptedUserName });
				}
			}
			// Format: encryptedUserName|lastReadId (both already encrypted)
			const readReceiptsArray = Array.from(mergedSeen.entries())
				.filter(([uid, data]) => uid !== userId && data.lastReadId)
				.map(([uid, data]) => `${data.encryptedUserName}|${data.lastReadId}`);

			// Encode headers to handle non-ASCII characters
			const encodedOnlineUsersHeader = encodeURIComponent(onlineUsersHeader);
			const encodedReadReceiptsHeader = encodeURIComponent(readReceiptsArray.join(','));

			const responseHeaders = {
				'Content-Type': 'application/json',
				'X-Online-Users': encodedOnlineUsersHeader
			};
			if (readReceiptsArray.length > 0) {
				responseHeaders['X-Read-Receipts'] = encodedReadReceiptsHeader;
			}

			const botTyping = [];
			for (const [key, val] of botTypingState) {
				if (!key.endsWith(`:${chatHandle}`)) continue;
				if (now - val.ts > BOT_TYPING_TTL) continue;
				botTyping.push(val.name);
			}
			res.writeHead(200, responseHeaders);
			res.end(JSON.stringify({ success: true, botTyping }));
		} catch (error) {
			console.error('Error processing heartbeat:', error);
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid heartbeat data' }));
		}
	});
}

// Handle reaction toggle
// POST /react/{chatHandle}/{messageId}
// Body: { encryptedEmoji, encryptedUserName }
// encryptedEmoji uses deterministic IV so same emoji always produces same ciphertext for this message.
// Server stores { userIds: [], encryptedUserNames: {} } per emoji and toggles on/off.
function handleReaction(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[2];
	const messageId = decodeURIComponent(parts.slice(3).join('/'));

	const authorization = req.headers.authorization || '';
	const [userId] = authorization.split(':');

	if (!chatHandle || !messageId || !userId) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Missing params' }));
		return;
	}

	let body = '';
	req.on('data', chunk => { body += chunk.toString(); });
	req.on('end', () => {
		try {
			// Channel guard — reactions disabled in channels
			if (CHANNEL_MAP.has(chatHandle)) {
				res.writeHead(403, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Reactions are not supported in channels' }));
				return;
			}
			const { encryptedEmoji, encryptedUserName } = JSON.parse(body);
			if (!encryptedEmoji) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Missing encryptedEmoji' }));
				return;
			}

			const chatMessages = messagesStorage.get(chatHandle) || [];
			const message = chatMessages.find(m => m.id === messageId);
			if (!message) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Message not found' }));
				return;
			}

			if (!message.reactions[encryptedEmoji]) {
				message.reactions[encryptedEmoji] = { userIds: [], encryptedUserNames: {} };
			}

			const reactionData = message.reactions[encryptedEmoji];
			const existingIdx = reactionData.userIds.indexOf(userId);

			if (existingIdx !== -1) {
				// Toggle off: remove
				reactionData.userIds.splice(existingIdx, 1);
				delete reactionData.encryptedUserNames[userId];
				// Clean up empty reaction group
				if (reactionData.userIds.length === 0) {
					delete message.reactions[encryptedEmoji];
				}
			} else {
				// Toggle on: add
				reactionData.userIds.push(userId);
				if (encryptedUserName) reactionData.encryptedUserNames[userId] = encryptedUserName;
			}

			message.lastUpdated = Date.now();
			appendReactionPatchToDisk(chatHandle, messageId, message.reactions, message.lastUpdated);

			// Return updated reactions for this message (isMine computed for requester)
			const transformedReactions = {};
			for (const [emoji, data] of Object.entries(message.reactions)) {
				transformedReactions[emoji] = {
					count: data.userIds.length,
					isMine: data.userIds.includes(userId)
				};
			}

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true, reactions: transformedReactions }));
		} catch (e) {
			console.error('Reaction error:', e);
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid data' }));
		}
	});
}

// Handle message edit
// POST /edit/{chatHandle}/{messageId}
// Body: { encryptedContent, encryptedEditTimestamp }
// Auth: only the original sender (senderUserId) may edit.
function handleEditMessage(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[2];
	const messageId = decodeURIComponent(parts.slice(3).join('/'));

	const authorization = req.headers.authorization || '';
	const [userId] = authorization.split(':');

	if (!chatHandle || !messageId || !userId) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Missing params' }));
		return;
	}

	let body = '';
	req.on('data', chunk => { body += chunk.toString(); });
	req.on('end', () => {
		try {
			// Channel guard — only admin may edit
			const editChannel = CHANNEL_MAP.get(chatHandle);
			if (editChannel && userId !== editChannel.adminUserId) {
				res.writeHead(403, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Not authorized to edit in this channel' }));
				return;
			}
			const { encryptedContent, encryptedEditTimestamp } = JSON.parse(body);

			const chatMessages = messagesStorage.get(chatHandle) || [];
			const message = chatMessages.find(m => m.id === messageId);

			if (!message) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Message not found' }));
				return;
			}

			// Only the original sender may edit
			if (message.senderUserId !== userId) {
				res.writeHead(403, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Forbidden' }));
				return;
			}

			// Validate the edit timestamp (server-key encrypted)
			try {
				decryptTimestamp(encryptedEditTimestamp);
			} catch (e) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid edit timestamp' }));
				return;
			}

			// Apply edit
			message.encryptedContent = encryptedContent;
			message.edits.push({ encryptedEditTimestamp });
			message.lastUpdated = Date.now();
			appendEditPatchToDisk(chatHandle, messageId, encryptedContent, message.edits, message.lastUpdated);

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true }));
		} catch (e) {
			console.error('Edit error:', e);
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid data' }));
		}
	});
}

// Handle upload chunk request
function handleUploadChunk(req, res, pathname) {
	console.log(`POST upload-chunk request for path: ${pathname}`);

	// Extract chat handle from URL path
	// Format: /upload-chunk/chatHandle
	const parts = pathname.split('/');
	const chatHandle = parts[2];

	if (!chatHandle) {
		console.log('Chat handle is required');
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle is required' }));
		return;
	}

	// Channel guard — only admin may upload
	const [chunkUserId] = (req.headers.authorization || '').split(':');
	const uploadChannel = CHANNEL_MAP.get(chatHandle);
	if (uploadChannel && chunkUserId !== uploadChannel.adminUserId) {
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not authorized to post in this channel' }));
		return;
	}

	let bodyChunks = [];

	req.on('error', (err) => {
		console.error('Upload chunk request error:', err);
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Request error' }));
	});

	req.on('data', (chunk) => {
		bodyChunks.push(chunk);
	});

	req.on('end', () => {
		try {
			const body = Buffer.concat(bodyChunks);
			let sessionId, chunkIndex, totalChunks, messageType, chunkData;

			const contentType = req.headers['content-type'] || '';
			if (contentType.includes('application/json')) {
				// JSON format with base64-encoded chunk data
				const parsed = JSON.parse(body.toString('utf8'));
				sessionId = parsed.sessionId;
				chunkIndex = parsed.chunkIndex;
				totalChunks = parsed.totalChunks;
				messageType = parsed.messageType;
				chunkData = Buffer.from(parsed.chunkData, 'base64');
			} else {
				// Legacy binary format: metadata\r\n\r\nchunkData
				const separator = Buffer.from('\r\n\r\n');
				const metadataEnd = body.indexOf(separator);
				if (metadataEnd === -1) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Invalid chunk format' }));
					return;
				}
				const metadata = JSON.parse(body.slice(0, metadataEnd).toString('utf8'));
				sessionId = metadata.sessionId;
				chunkIndex = metadata.chunkIndex;
				totalChunks = metadata.totalChunks;
				messageType = metadata.messageType;
				chunkData = body.slice(metadataEnd + separator.length);
			}

			console.log(`Received chunk ${chunkIndex}/${totalChunks} for session ${sessionId}`);

			// Get or create upload session
			let session = uploadSessions.get(sessionId);
			if (!session) {
				session = {
					chatHandle: chatHandle,
					chunks: new Map(),
					totalChunks: totalChunks,
					createdAt: Date.now(),
					messageType: messageType
				};
				uploadSessions.set(sessionId, session);
				console.log(`Created new upload session: ${sessionId}`);
			}

			// Store the chunk as a Buffer
			session.chunks.set(chunkIndex, chunkData);
			console.log(`Stored chunk ${chunkIndex}, total chunks received: ${session.chunks.size}/${totalChunks}`);

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				success: true,
				sessionId: sessionId,
				chunkIndex: chunkIndex,
				receivedChunks: session.chunks.size,
				totalChunks: totalChunks
			}));
		} catch (error) {
			console.error('Error processing chunk:', error.stack || error);
			if (!res.headersSent) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Chunk processing error', detail: error.message }));
			}
		}
	});
}

// Handle upload complete request - assemble chunks and store message
function handleUploadComplete(req, res, pathname) {
	console.log(`POST upload-complete request for path: ${pathname}`);

	// Extract chat handle from URL path
	// Format: /upload-complete/chatHandle
	const parts = pathname.split('/');
	const chatHandle = parts[2];

	if (!chatHandle) {
		console.log('Chat handle is required');
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle is required' }));
		return;
	}

	let body = '';

	req.on('data', (chunk) => {
		body += chunk.toString();
	});

	req.on('end', () => {
		try {
			const completeData = JSON.parse(body);
			const { sessionId, encryptedName, encryptedTimestamp, messageType, isCompressed, encryptedMeta, stickerId, replyTo, keyFp, chatSignature } = completeData;
			const [senderUserId] = (req.headers.authorization || '').split(':');

			const session = uploadSessions.get(sessionId);
			if (!session) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Upload session not found' }));
				return;
			}

			// Verify all chunks were received
			if (session.chunks.size !== session.totalChunks) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					error: `Incomplete upload. Expected ${session.totalChunks} chunks, got ${session.chunks.size}`
				}));
				return;
			}

			// Assemble chunks in order
			const sortedChunkIndices = Array.from(session.chunks.keys()).sort((a, b) => a - b);
			const assembledChunks = [];

			for (const index of sortedChunkIndices) {
				assembledChunks.push(session.chunks.get(index));
			}

			// Combine all chunks into single buffer
			const encryptedContent = Buffer.concat(assembledChunks).toString('base64');

			// Store encrypted content for deferred downloads using composite key (use encryptedTimestamp as ID)
			const contentKey = `${chatHandle}:${encryptedTimestamp}`;
			messageContentStorage.set(contentKey, encryptedContent);
			console.log(`Cached encrypted content for key: ${contentKey}`);

			// Store compression metadata using messageId (which is encryptedTimestamp)
			const messageId = encryptedTimestamp;
			messageMetadata.set(messageId, { isCompressed: isCompressed || false });
			console.log(`Stored compression metadata for message ${messageId}: ${isCompressed}`);

			// Decrypt timestamp for validation (security check)
			try {
				decryptTimestamp(encryptedTimestamp);
			} catch (err) {
				console.warn('Failed to decrypt timestamp:', err);
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid encrypted timestamp' }));
				return;
			}

			// Chat key signature check
			const uploadChannel = CHANNEL_MAP.get(chatHandle);
			if (!uploadChannel && !verifyChatSignature(chatHandle, encryptedTimestamp, chatSignature)) {
				res.writeHead(403, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid chat signature' }));
				return;
			}

			// Create message object with encrypted timestamp as ID (consistent with text messages)
			const message = {
				sender: null, // Will use encryptedName for sender
				encryptedName: encryptedName,
				encryptedContent: null, // Content is stored separately, not in message
				encryptedTimestamp: encryptedTimestamp, // Encrypted timestamp for consistency
				type: messageType || 'file',
				id: encryptedTimestamp, // Use encrypted timestamp as ID
				keyFp: keyFp || null,
				encryptedMeta: encryptedMeta || null,
				stickerId: stickerId || null,
				replyTo: replyTo || null,
				senderUserId,
				reactions: {},
				edits: []
			};

			// Store message
			if (!messagesStorage.has(chatHandle)) {
				messagesStorage.set(chatHandle, []);
			}
			messagesStorage.get(chatHandle).push(message);
			console.log(`Stored message for chat handle: ${chatHandle} with encrypted ID: ${encryptedTimestamp}`);

			// Track last message time per user
			if (userHeartbeats.has(chatHandle)) {
				const cu = userHeartbeats.get(chatHandle).get(senderUserId);
				if (cu) cu.lastMessageTime = Date.now();
			}

			// Persist to disk (include binary content for images/voice)
			appendMessageToDisk(chatHandle, message, encryptedContent, isCompressed || false);

			// Keep only last 100 messages
			const chatMessages = messagesStorage.get(chatHandle);
			if (chatMessages.length > 100) {
				const removedMsg = chatMessages.shift();
				// Also remove from content storage
				const oldContentKey = `${chatHandle}:${removedMsg.id}`;
				messageContentStorage.delete(oldContentKey);
				console.log(`Trimmed messages for chat handle: ${chatHandle}`);
			}

			// Clean up session
			uploadSessions.delete(sessionId);
			console.log(`Cleaned up upload session: ${sessionId}`);

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				success: true,
				messageId: message.id,
				messageType: messageType
			}));
		} catch (error) {
			console.error('Error completing upload:', error);
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Failed to complete upload' }));
		}
	});
}

// Handle upload cancel request
function handleUploadCancel(req, res, pathname) {
	console.log(`POST upload-cancel request for path: ${pathname}`);

	// Extract chat handle from URL path
	// Format: /upload-cancel/chatHandle
	const parts = pathname.split('/');
	const chatHandle = parts[2];

	if (!chatHandle) {
		console.log('Chat handle is required');
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle is required' }));
		return;
	}

	let body = '';

	req.on('data', (chunk) => {
		body += chunk.toString();
	});

	req.on('end', () => {
		try {
			const cancelData = JSON.parse(body);
			const { sessionId } = cancelData;

			const session = uploadSessions.get(sessionId);
			if (!session) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Upload session not found' }));
				return;
			}

			// Clean up session
			uploadSessions.delete(sessionId);
			console.log(`Cancelled upload session: ${sessionId}`);

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true }));
		} catch (error) {
			console.error('Error cancelling upload:', error);
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Failed to cancel upload' }));
		}
	});
}

// Handle download content request - serves deferred binary data
function handleDownloadContent(req, res, pathname) {
	console.log(`GET download-content request for path: ${pathname}`);

	// Extract chatHandle and encoded messageId from URL path
	// Format: /download-content/chatHandle/encodedMessageId
	const parts = pathname.split('/');
	const chatHandle = parts[2];
	const encodedMessageId = parts[3];

	if (!chatHandle || !encodedMessageId) {
		console.log('Chat handle and message ID are required');
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle and message ID are required' }));
		return;
	}

	// URL-decode the messageId
	const messageId = decodeURIComponent(encodedMessageId);

	const contentKey = `${chatHandle}:${messageId}`;
	const contentData = messageContentStorage.get(contentKey);

	if (!contentData) {
		// Fallback: scan disk (e.g. after server restart or for history messages)
		const fp = chatToFilePath(chatHandle);
		if (fs.existsSync(fp)) {
			const rawLines = fs.readFileSync(fp, 'utf8').split('\n').filter(l => l.trim());
			for (const line of rawLines) {
				try {
					const entry = JSON.parse(line);
					if (entry.msg.id === messageId && entry.content) {
						messageContentStorage.set(contentKey, entry.content);
						messageMetadata.set(messageId, { isCompressed: entry.isCompressed || false });
						const meta = messageMetadata.get(messageId);
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ encryptedContent: entry.content, isCompressed: meta.isCompressed }));
						return;
					}
				} catch (e) {}
			}
		}
		console.log(`Content not found for key: ${contentKey}`);
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Content not found' }));
		return;
	}

	console.log(`Serving content for message ${messageId} (${contentData.length} bytes)`);

	// Get compression metadata
	const metadata = messageMetadata.get(messageId) || { isCompressed: false };

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({
		encryptedContent: contentData,
		isCompressed: metadata.isCompressed
	}));
}

// Handle GET /history/:chatHandle?before=<messageId>&limit=50
function handleGetHistory(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[2];
	if (!chatHandle) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle is required' }));
		return;
	}

	const query = url.parse(req.url, true).query;
	const beforeId = query.before;
	const limit = Math.min(parseInt(query.limit || '50', 10), 100);

	const authorization = req.headers.authorization || '';
	const [requestingUserId] = authorization.split(':');

	const fp = chatToFilePath(chatHandle);
	if (!fs.existsSync(fp)) {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end('[]');
		return;
	}

	const rawLines = fs.readFileSync(fp, 'utf8').split('\n').filter(l => l.trim());
	const messageMap = new Map(); // preserve order, deduplicate
	const patches = [];
	const orderedIds = []; // track insertion order

	for (const line of rawLines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed.type === 'reaction_patch' || parsed.type === 'edit_patch') {
				patches.push(parsed);
			} else if (parsed && parsed.msg && parsed.msg.id) {
				if (!messageMap.has(parsed.msg.id)) orderedIds.push(parsed.msg.id);
				messageMap.set(parsed.msg.id, parsed);
			}
		} catch (e) {}
	}

	// Apply patches (reactions + edits)
	for (const patch of patches) {
		const entry = messageMap.get(patch.messageId);
		if (!entry) continue;
		if (patch.type === 'reaction_patch') {
			entry.msg.reactions = patch.reactions;
		} else if (patch.type === 'edit_patch') {
			entry.msg.encryptedContent = patch.encryptedContent;
			entry.msg.edits = patch.edits;
		}
		if (patch.lastUpdated) entry.msg.lastUpdated = patch.lastUpdated;
	}

	// Rebuild ordered entries array
	const entries = orderedIds.map(id => messageMap.get(id));

	// Find the index of the message with beforeId; default to end of array
	let beforeIndex = entries.length;
	if (beforeId) {
		const idx = entries.findIndex(e => e.msg && e.msg.id === beforeId);
		if (idx >= 0) beforeIndex = idx;
	}

	const slice = entries.slice(Math.max(0, beforeIndex - limit), beforeIndex);

	// Eagerly load content into memory so /download-content/ works for these messages
	for (const entry of slice) {
		if (entry.content) {
			const contentKey = `${chatHandle}:${entry.msg.id}`;
			if (!messageContentStorage.has(contentKey)) {
				messageContentStorage.set(contentKey, entry.content);
			}
			if (entry.msg.id) {
				messageMetadata.set(entry.msg.id, { isCompressed: entry.isCompressed || false });
			}
		}
	}

	const messages = slice.map(e => e.msg);
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(messages.map(m => serializeMessageForClient(m, requestingUserId))));
}

// ==================== P2P TRANSFER HANDLERS ====================

// Handle POST /transfer/initiate/{chatHandle} - Initiate a P2P file transfer
function handleTransferInitiate(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3]; // /transfer/initiate/chatHandle

	if (!chatHandle) {
		logP2PTransfer('INITIATE', 'N/A', 'ERROR', { statusCode: 400, error: 'Missing chat handle' });
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle is required' }));
		return;
	}

	// Extract senderId from Authorization header
	const [senderId] = req.headers.authorization.split(':');

	let body = '';
	req.on('data', (chunk) => {
		body += chunk.toString();
	});

	req.on('end', () => {
		try {
			const initData = JSON.parse(body);
			const { fileName, fileSize, totalChunks, sha256FileChecksum } = initData;

			// Check concurrent transfer limits
			const counts = getP2PTransferCounts(senderId);
			if (counts.sending >= P2P_MAX_CONCURRENT) {
				logP2PTransfer('INITIATE', 'N/A', 'LIMIT_EXCEEDED', {
					statusCode: 400,
					chatHandle,
					userId: senderId,
					error: `Concurrent limit exceeded (${counts.sending}/${P2P_MAX_CONCURRENT})`
				});
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					error: 'Concurrent transfer limit exceeded',
					current: counts.sending,
					limit: P2P_MAX_CONCURRENT
				}));
				return;
			}

			// Generate transfer session ID
			const transferSessionId = `p2p-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

			// Create transfer session (simplified - no receiverId)
			const transfer = {
				id: transferSessionId,
				chatHandle: chatHandle,
				senderId: senderId,
				fileName: fileName,
				fileSize: fileSize,
				totalChunks: totalChunks,
				sha256Checksum: sha256FileChecksum,
				status: 'PENDING',
				createdAt: Date.now(),
				acceptedAt: null,
				completedAt: null,
				chunks: new Map(),
				lastChunkACKed: -1,
				lastChunkSentTime: null,
				retryCount: 0
			};

			p2pTransfers.set(transferSessionId, transfer);
			logP2PTransfer('INITIATE', transferSessionId, 'PENDING', {
				statusCode: 200,
				chatHandle,
				userId: senderId,
				fileName: fileName,
				progress: `0/${totalChunks}`
			});

			// Store invitation for this chat room (indexed by chatHandle, not userId)
			if (!transferInvitations.has(chatHandle)) {
				transferInvitations.set(chatHandle, []);
			}

			// Look up sender's encrypted username from heartbeats
			let senderName = null;
			const chatUsers = userHeartbeats.get(chatHandle);
			if (chatUsers && chatUsers.has(senderId)) {
				senderName = chatUsers.get(senderId).encryptedUserName;
			}

			const chatInvitations = transferInvitations.get(chatHandle);
			chatInvitations.push({
				transferSessionId: transferSessionId,
				chatHandle: chatHandle,
				senderId: senderId,
				senderName: senderName,
				fileName: fileName,
				fileSize: fileSize,
				totalChunks: totalChunks,
				createdAt: Date.now()
			});

			logP2PTransfer('INITIATE', transferSessionId, 'INVITATION_CREATED', {
				chatHandle,
				progress: `${chatInvitations.length} pending`
			});

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				success: true,
				transferSessionId: transferSessionId,
				status: 'PENDING'
			}));
		} catch (error) {
			logP2PTransfer('INITIATE', 'N/A', 'ERROR', {
				statusCode: 400,
				chatHandle,
				error: error.message
			});
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid transfer initiation data' }));
		}
	});
}

// Handle GET /transfer/invitations/{chatHandle} - Get pending invitations for receiver in this chat
function handleTransferGetInvitations(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3]; // /transfer/invitations/chatHandle

	if (!chatHandle) {
		logP2PTransfer('GET_INVITATIONS', 'N/A', 'ERROR', { statusCode: 400, error: 'Missing chat handle' });
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle is required' }));
		return;
	}

	// Extract userId from Authorization header to filter out sender's own invitations
	const [userId] = req.headers.authorization.split(':');

	// Get pending transfers in this chat, excluding sender's own
	const chatInvitations = (transferInvitations.get(chatHandle) || [])
		.filter(inv => inv.senderId !== userId);

	logP2PTransfer('GET_INVITATIONS', 'N/A', 'SUCCESS', {
		statusCode: 200,
		chatHandle,
		userId,
		progress: `${chatInvitations.length} pending invitations`
	});

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ invitations: chatInvitations }));
}

// Handle POST /transfer/accept/{chatHandle}/{transferSessionId} - Accept a transfer invitation
function handleTransferAccept(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];
	const transferSessionId = parts[4];

	if (!chatHandle || !transferSessionId) {
		logP2PTransfer('ACCEPT', 'N/A', 'ERROR', { statusCode: 400, error: 'Missing parameters' });
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle and transfer session ID are required' }));
		return;
	}

	// Extract userId from Authorization header
	const [userId] = req.headers.authorization.split(':');

	const transfer = p2pTransfers.get(transferSessionId);
	if (!transfer) {
		logP2PTransfer('ACCEPT', transferSessionId, 'NOT_FOUND', { statusCode: 404, chatHandle });
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Transfer session not found' }));
		return;
	}

	// Verify transfer belongs to this chat (simplified authorization)
	if (transfer.chatHandle !== chatHandle) {
		logP2PTransfer('ACCEPT', transferSessionId, 'CHAT_MISMATCH', {
			statusCode: 403,
			chatHandle,
			userId,
			error: `Transfer belongs to ${transfer.chatHandle}`
		});
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Transfer does not belong to this chat' }));
		return;
	}

	// Check concurrent transfer limits for this user
	const counts = getP2PTransferCounts(userId);
	if (counts.receiving >= P2P_MAX_CONCURRENT) {
		logP2PTransfer('ACCEPT', transferSessionId, 'LIMIT_EXCEEDED', {
			statusCode: 400,
			chatHandle,
			userId,
			error: `Recv limit (${counts.receiving}/${P2P_MAX_CONCURRENT})`
		});
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			error: 'Concurrent receive limit exceeded',
			current: counts.receiving,
			limit: P2P_MAX_CONCURRENT
		}));
		return;
	}

	// Update transfer status
	transfer.status = 'ACCEPTED';
	transfer.acceptedAt = Date.now();
	transfer.receiverId = userId;

	// Remove from pending invitations in this chat
	const chatInvitations = transferInvitations.get(chatHandle);
	if (chatInvitations) {
		const index = chatInvitations.findIndex(inv => inv.transferSessionId === transferSessionId);
		if (index !== -1) {
			chatInvitations.splice(index, 1);
		}
	}

	logP2PTransfer('ACCEPT', transferSessionId, 'ACCEPTED', {
		statusCode: 200,
		chatHandle,
		userId,
		fileName: transfer.fileName,
		progress: `0/${transfer.totalChunks}`
	});

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({
		success: true,
		transferSessionId: transferSessionId,
		status: 'ACCEPTED',
		totalChunks: transfer.totalChunks
	}));
}

// Handle POST /transfer/send-chunk/{chatHandle}/{transferSessionId} - Sender pushes a chunk
function handleTransferSendChunk(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];
	const transferSessionId = parts[4];

	if (!chatHandle || !transferSessionId) {
		logP2PTransfer('SEND_CHUNK', 'N/A', 'ERROR', { statusCode: 400, error: 'Missing parameters' });
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle and transfer session ID are required' }));
		return;
	}

	// Extract senderId from Authorization header
	const [senderId] = req.headers.authorization.split(':');

	const transfer = p2pTransfers.get(transferSessionId);
	if (!transfer) {
		logP2PTransfer('SEND_CHUNK', transferSessionId, 'NOT_FOUND', { statusCode: 404, chatHandle });
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Transfer session not found' }));
		return;
	}

	// Verify sender is authorized (only sender can send chunks)
	if (transfer.senderId !== senderId) {
		logP2PTransfer('SEND_CHUNK', transferSessionId, 'UNAUTHORIZED', {
			statusCode: 403,
			chatHandle,
			error: `Sender mismatch: expected ${transfer.senderId}, got ${senderId}`
		});
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not authorized to send chunks for this transfer' }));
		return;
	}

	// Verify transfer belongs to this chat
	if (transfer.chatHandle !== chatHandle) {
		logP2PTransfer('SEND_CHUNK', transferSessionId, 'CHAT_MISMATCH', { statusCode: 403, chatHandle });
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Transfer does not belong to this chat' }));
		return;
	}

	// Check if transfer is in valid state for sending chunks
	if (!['ACCEPTED', 'TRANSFERRING'].includes(transfer.status)) {
		logP2PTransfer('SEND_CHUNK', transferSessionId, 'INVALID_STATE', {
			statusCode: 400,
			chatHandle,
			error: `Status: ${transfer.status}`
		});
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Transfer is not in valid state for sending chunks' }));
		return;
	}

	let bodyChunks = [];
	req.on('data', (chunk) => {
		bodyChunks.push(chunk);
	});

	req.on('end', () => {
		try {
			// Parse multipart format: JSON metadata + \r\n\r\n + binary chunk data
			const body = Buffer.concat(bodyChunks);
			
			// Parse multipart format: JSON metadata + \r\n\r\n + binary chunk data
			const dataStr = body.toString('utf8');
			const metadataEnd = dataStr.indexOf('\r\n\r\n');
			
			if (metadataEnd === -1) {
				logP2PTransfer('SEND_CHUNK', transferSessionId, 'INVALID_FORMAT', { statusCode: 400, chatHandle });
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid chunk format' }));
				return;
			}

			const metadataStr = dataStr.substring(0, metadataEnd);
			const metadata = JSON.parse(metadataStr);
			const { chunkIndex, chunkSize } = metadata;

			// For ACK-based flow control: sender can only send the next expected chunk
			const nextExpectedChunk = transfer.lastChunkACKed + 1;
			if (chunkIndex !== nextExpectedChunk) {
				logP2PTransfer('SEND_CHUNK', transferSessionId, 'SEQUENCE_ERROR', {
					statusCode: 400,
					chatHandle,
					chunkIndex,
					totalChunks: transfer.totalChunks,
					error: `Expected ${nextExpectedChunk}, got ${chunkIndex}`
				});
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					error: `Invalid chunk sequence. Expected chunk ${nextExpectedChunk}, got ${chunkIndex}`
				}));
				return;
			}

			// Validate chunk size
			if (chunkSize > P2P_CHUNK_SIZE) {
				logP2PTransfer('SEND_CHUNK', transferSessionId, 'SIZE_EXCEEDED', {
					statusCode: 400,
					chatHandle,
					chunkIndex,
					error: `${chunkSize} > ${P2P_CHUNK_SIZE}`
				});
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Chunk size exceeds maximum' }));
				return;
			}

			// Extract binary chunk data
			const chunkDataStart = metadataEnd + 4;
			const chunkData = body.slice(chunkDataStart);

			// Store chunk
			transfer.chunks.set(chunkIndex, chunkData);
			transfer.lastChunkSentTime = Date.now();
			transfer.status = 'TRANSFERRING';

			logP2PTransfer('SEND_CHUNK', transferSessionId, 'TRANSFERRING', {
				statusCode: 200,
				chatHandle,
				chunkIndex,
				totalChunks: transfer.totalChunks,
				fileName: transfer.fileName,
				progress: `${chunkIndex + 1}/${transfer.totalChunks}`
			});

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				success: true,
				chunkIndex: chunkIndex,
				queued: true,
				lastACKedChunk: transfer.lastChunkACKed
			}));
		} catch (error) {
			logP2PTransfer('SEND_CHUNK', transferSessionId, 'ERROR', {
				statusCode: 400,
				chatHandle,
				error: error.message
			});
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid chunk data' }));
		}
	});
}

// Handle GET /transfer/receive-chunk/{chatHandle}/{transferSessionId} - Receiver polls for chunks with ACK
function handleTransferReceiveChunk(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];
	const transferSessionId = parts[4];

	if (!chatHandle || !transferSessionId) {
		logP2PTransfer('RECEIVE_CHUNK', 'N/A', 'ERROR', { statusCode: 400, error: 'Missing parameters' });
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle and transfer session ID are required' }));
		return;
	}

	const transfer = p2pTransfers.get(transferSessionId);
	if (!transfer) {
		logP2PTransfer('RECEIVE_CHUNK', transferSessionId, 'NOT_FOUND', { statusCode: 410, chatHandle });
		res.writeHead(410, { 'Content-Type': 'application/json' }); // 410 Gone
		res.end(JSON.stringify({ error: 'Transfer session not found or expired' }));
		return;
	}

	// Verify transfer belongs to this chat (simplified authorization)
	if (transfer.chatHandle !== chatHandle) {
		logP2PTransfer('RECEIVE_CHUNK', transferSessionId, 'CHAT_MISMATCH', { statusCode: 403, chatHandle });
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Transfer does not belong to this chat' }));
		return;
	}

	// Parse query parameters
	const query = url.parse(req.url, true).query;
	const ackChunkIndex = query.ackChunkIndex != null ? parseInt(query.ackChunkIndex, 10) : -1;
	const maxWaitMs = parseInt(query.maxWaitMs) || 5000;

	// Update the ACK - receiver is acknowledging all chunks up to this index
	if (ackChunkIndex > transfer.lastChunkACKed) {
		transfer.lastChunkACKed = ackChunkIndex;
		logP2PTransfer('RECEIVE_CHUNK', transferSessionId, 'ACK_RECEIVED', {
			chatHandle,
			chunkIndex: ackChunkIndex,
			totalChunks: transfer.totalChunks,
			progress: `${ackChunkIndex + 1}/${transfer.totalChunks}`
		});
	}

	// Find next chunk to send
	let nextChunkIndex = transfer.lastChunkACKed + 1;
	
	// If we've sent all chunks, we're done
	if (nextChunkIndex >= transfer.totalChunks) {
		// All chunks have been sent and ACKed
		logP2PTransfer('RECEIVE_CHUNK', transferSessionId, 'COMPLETE', {
			statusCode: 200,
			chatHandle,
			fileName: transfer.fileName,
			progress: `${transfer.totalChunks}/${transfer.totalChunks}`
		});
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			chunkIndex: nextChunkIndex - 1,
			isLastChunk: true,
			pendingChunks: 0,
			totalChunks: transfer.totalChunks
		}));
		return;
	}

	// Wait for the next chunk to become available
	const startTime = Date.now();
	const checkInterval = 100; // Check every 100ms

	const checkForChunk = () => {
		const elapsed = Date.now() - startTime;
		
		if (elapsed >= maxWaitMs) {
			// Timeout - no chunk available yet, return empty response
			logP2PTransfer('RECEIVE_CHUNK', transferSessionId, 'POLL_TIMEOUT', {
				statusCode: 204,
				chatHandle,
				chunkIndex: nextChunkIndex,
				totalChunks: transfer.totalChunks
			});
			res.writeHead(204, { 'Content-Type': 'application/json' });
			res.end();
			return;
		}

		if (transfer.chunks.has(nextChunkIndex)) {
			// Chunk is available, return it
			const chunkData = transfer.chunks.get(nextChunkIndex);
			const isLastChunk = nextChunkIndex === transfer.totalChunks - 1;
			const pendingChunks = transfer.totalChunks - nextChunkIndex - 1;

			// Don't delete chunks here - keep them until transfer is complete
			// This allows the download endpoint to work

			logP2PTransfer('RECEIVE_CHUNK', transferSessionId, 'CHUNK_SENT', {
				statusCode: 200,
				chatHandle,
				chunkIndex: nextChunkIndex,
				totalChunks: transfer.totalChunks,
				fileName: transfer.fileName,
				progress: `${nextChunkIndex + 1}/${transfer.totalChunks}`
			});

			res.writeHead(200, {
				'Content-Type': 'application/json',
				'X-Chunk-Index': nextChunkIndex,
				'X-Is-Last': isLastChunk
			});
			res.end(JSON.stringify({
				chunkIndex: nextChunkIndex,
				chunkData: chunkData.toString('base64'),
				isLastChunk: isLastChunk,
				pendingChunks: pendingChunks,
				totalChunks: transfer.totalChunks
			}));
			return;
		}

		// Chunk not ready yet, check again soon
		setTimeout(checkForChunk, checkInterval);
	};

	checkForChunk();
}

// Handle POST /transfer/complete/{chatHandle}/{transferSessionId} - Mark transfer as complete
function handleTransferComplete(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];
	const transferSessionId = parts[4];

	if (!chatHandle || !transferSessionId) {
		logP2PTransfer('COMPLETE', 'N/A', 'ERROR', { statusCode: 400, error: 'Missing parameters' });
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle and transfer session ID are required' }));
		return;
	}

	// Extract senderId from Authorization header
	const [senderId] = req.headers.authorization.split(':');

	let body = '';
	req.on('data', (chunk) => {
		body += chunk.toString();
	});

	req.on('end', () => {
		try {
			const completeData = JSON.parse(body);
			const { totalChunks, sha256Checksum, fileName } = completeData;

			const transfer = p2pTransfers.get(transferSessionId);
			if (!transfer) {
				logP2PTransfer('COMPLETE', transferSessionId, 'NOT_FOUND', { statusCode: 404, chatHandle });
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Transfer session not found' }));
				return;
			}

			// Verify sender is authorized
			if (transfer.senderId !== senderId) {
				logP2PTransfer('COMPLETE', transferSessionId, 'UNAUTHORIZED', {
					statusCode: 403,
					chatHandle,
					userId: senderId,
					error: `Sender mismatch: expected ${transfer.senderId}`
				});
				res.writeHead(403, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Not authorized to complete this transfer' }));
				return;
			}

			// Update transfer status
			transfer.status = 'COMPLETED';
			transfer.completedAt = Date.now();
			transfer.totalChunks = totalChunks; // Update if different
			transfer.sha256Checksum = sha256Checksum;
			transfer.fileName = fileName || transfer.fileName;

			logP2PTransfer('COMPLETE', transferSessionId, 'COMPLETED', {
				statusCode: 200,
				chatHandle,
				userId: senderId,
				fileName: transfer.fileName,
				progress: `${transfer.totalChunks}/${transfer.totalChunks}`
			});

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				success: true,
				status: 'COMPLETED',
				completedAt: transfer.completedAt
			}));
		} catch (error) {
			logP2PTransfer('COMPLETE', transferSessionId, 'ERROR', {
				statusCode: 400,
				chatHandle,
				error: error.message
			});
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid completion data' }));
		}
	});
}

// Handle GET /transfer/download/{chatHandle}/{transferSessionId} - Download assembled file
function handleTransferDownload(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];
	const transferSessionId = parts[4];

	if (!chatHandle || !transferSessionId) {
		logP2PTransfer('DOWNLOAD', 'N/A', 'ERROR', { statusCode: 400, error: 'Missing parameters' });
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle and transfer session ID are required' }));
		return;
	}

	// Extract userId from Authorization header
	const [userId] = req.headers.authorization.split(':');

	const transfer = p2pTransfers.get(transferSessionId);
	if (!transfer) {
		logP2PTransfer('DOWNLOAD', transferSessionId, 'NOT_FOUND', { statusCode: 404, chatHandle });
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Transfer session not found' }));
		return;
	}

	// Verify transfer belongs to this chat
	if (transfer.chatHandle !== chatHandle) {
		logP2PTransfer('DOWNLOAD', transferSessionId, 'CHAT_MISMATCH', {
			statusCode: 403,
			chatHandle,
			userId,
			error: `Transfer belongs to ${transfer.chatHandle}`
		});
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Transfer does not belong to this chat' }));
		return;
	}

	// Verify transfer is complete
	if (transfer.status !== 'COMPLETED') {
		logP2PTransfer('DOWNLOAD', transferSessionId, 'NOT_COMPLETE', {
			statusCode: 400,
			chatHandle,
			userId,
			error: `Status: ${transfer.status}`
		});
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Transfer is not complete yet' }));
		return;
	}

	// Verify all chunks have been received and ACKed
	const expectedChunks = transfer.totalChunks;
	if (transfer.lastChunkACKed < expectedChunks - 1) {
		logP2PTransfer('DOWNLOAD', transferSessionId, 'INCOMPLETE_CHUNKS', {
			statusCode: 400,
			chatHandle,
			userId,
			progress: `${transfer.lastChunkACKed + 1}/${expectedChunks}`
		});
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			error: 'Not all chunks have been received',
			received: transfer.lastChunkACKed + 1,
			expected: expectedChunks
		}));
		return;
	}

	// All chunks should be in the chunks map - assemble them
	const sortedIndices = Array.from(transfer.chunks.keys()).sort((a, b) => a - b);
	const chunkBuffers = sortedIndices.map(index => transfer.chunks.get(index));

	if (chunkBuffers.length !== expectedChunks) {
		logP2PTransfer('DOWNLOAD', transferSessionId, 'MISSING_CHUNKS', {
			statusCode: 500,
			chatHandle,
			userId,
			error: `Have ${chunkBuffers.length}, expected ${expectedChunks}`
		});
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			error: 'Missing chunks',
			have: chunkBuffers.length,
			expected: expectedChunks
		}));
		return;
	}

	// Assemble file
	const fileBuffer = Buffer.concat(chunkBuffers);

	logP2PTransfer('DOWNLOAD', transferSessionId, 'SUCCESS', {
		statusCode: 200,
		chatHandle,
		userId,
		fileName: transfer.fileName,
		progress: `${fileBuffer.length / 1024 / 1024}MB`
	});

	// Set download headers
	res.writeHead(200, {
		'Content-Type': 'application/octet-stream',
		'Content-Disposition': `attachment; filename="${transfer.fileName}"`,
		'Content-Length': fileBuffer.length,
		'X-Transfer-Session': transferSessionId,
		'X-SHA256-Checksum': transfer.sha256Checksum
	});

	res.end(fileBuffer);
}

// Handle POST /transfer/cancel/{chatHandle}/{transferSessionId} - Cancel a transfer
function handleTransferCancel(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];
	const transferSessionId = parts[4];

	if (!chatHandle || !transferSessionId) {
		logP2PTransfer('CANCEL', 'N/A', 'ERROR', { statusCode: 400, error: 'Missing parameters' });
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle and transfer session ID are required' }));
		return;
	}

	// Extract userId from Authorization header
	const [userId] = req.headers.authorization.split(':');

	const transfer = p2pTransfers.get(transferSessionId);
	if (!transfer) {
		logP2PTransfer('CANCEL', transferSessionId, 'NOT_FOUND', { statusCode: 404, chatHandle });
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Transfer session not found' }));
		return;
	}

	// Verify user is authorized (sender or receiver can cancel)
	if (transfer.senderId !== userId && transfer.receiverId !== userId) {
		logP2PTransfer('CANCEL', transferSessionId, 'UNAUTHORIZED', {
			statusCode: 403,
			chatHandle,
			userId,
			error: `Not sender (${transfer.senderId}) or receiver (${transfer.receiverId})`
		});
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not authorized to cancel this transfer' }));
		return;
	}

	// Mark as failed and cleanup
	transfer.status = 'FAILED';
	cleanupP2PTransfer(transferSessionId);

	logP2PTransfer('CANCEL', transferSessionId, 'CANCELLED', {
		statusCode: 200,
		chatHandle,
		userId,
		fileName: transfer.fileName,
		progress: `${transfer.lastChunkACKed + 1}/${transfer.totalChunks}`
	});

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({
		success: true,
		status: 'FAILED'
	}));
}

// Handle GET /transfer/status/{chatHandle}/{transferSessionId} - Get transfer status
function handleTransferStatus(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];
	const transferSessionId = parts[4];

	if (!chatHandle || !transferSessionId) {
		logP2PTransfer('STATUS', 'N/A', 'ERROR', { statusCode: 400, error: 'Missing parameters' });
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle and transfer session ID are required' }));
		return;
	}

	// Extract userId from Authorization header
	const [userId] = req.headers.authorization.split(':');

	const transfer = p2pTransfers.get(transferSessionId);
	if (!transfer) {
		logP2PTransfer('STATUS', transferSessionId, 'NOT_FOUND', { statusCode: 404, chatHandle });
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Transfer session not found' }));
		return;
	}

	// Verify transfer belongs to this chat
	if (transfer.chatHandle !== chatHandle) {
		logP2PTransfer('STATUS', transferSessionId, 'CHAT_MISMATCH', {
			statusCode: 403,
			chatHandle,
			userId,
			error: `Transfer belongs to ${transfer.chatHandle}`
		});
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Transfer does not belong to this chat' }));
		return;
	}

	logP2PTransfer('STATUS', transferSessionId, transfer.status, {
		statusCode: 200,
		chatHandle,
		userId,
		fileName: transfer.fileName,
		progress: `${transfer.lastChunkACKed + 1}/${transfer.totalChunks}`
	});

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({
		transferSessionId: transfer.id,
		status: transfer.status,
		fileName: transfer.fileName,
		fileSize: transfer.fileSize,
		totalChunks: transfer.totalChunks,
		lastChunkACKed: transfer.lastChunkACKed,
		createdAt: transfer.createdAt,
		acceptedAt: transfer.acceptedAt,
		completedAt: transfer.completedAt,
		isSender: transfer.senderId === userId
	}));
}

// Serve static files using embedded assets
function serveFile(res, fileName, contentType) {
	console.log(`Attempting to serve file: ${fileName}`);

	// Try to get from embedded assets first, then fall back to file system
	let assetData = AssetLoader.getAsset(fileName);
	
	if (!assetData) {
		// Fall back to file system for development
		const filePath = path.join(__dirname, fileName);
		try {
			assetData = fs.readFileSync(filePath);
		} catch (err) {
			console.error(`Error reading file ${filePath}:`, err);
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			res.end('File not found');
			return;
		}
	}

	// Blob only carries server timestamp for time sync; credentials are client-generated
	const serverData = {
		timestamp: Date.now()
	};
	
	// Encrypt server data synchronously
	const encrypted = encryption.encryptBlockMessage(
		JSON.stringify(serverData),
		SERVER_PASSWRD
	);

	// create the key with index attached to it as prefix, then encrypt block cipher and put as value here
	let text = assetData.toString();
	text = text.replace(
		'{KEY_PLACE_HOLDER}',
		`<input type="text" name="" id="public_key" value="${encrypted}" style="display: none;">`,
	);

	console.log(`Successfully served file: ${fileName}`);
	res.writeHead(200, { 'Content-Type': contentType });
	res.end(Buffer.from(text));
}

// ==================== TIME SYNCHRONIZATION ====================

// Encrypt timestamp using server's private key
function encryptTimestamp(timestamp) {
	try {
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv('aes-256-gcm', encryption.padKey(SERVER_PASSWRD), iv);
		
		let encrypted = cipher.update(timestamp.toString(), 'utf8', 'binary');
		encrypted += cipher.final('binary');
		
		const authTag = cipher.getAuthTag();
		
		// Combine IV + encrypted + authTag
		const result = Buffer.concat([iv, Buffer.from(encrypted, 'binary'), authTag]);
		
		// Convert to base64 for transmission
		return result.toString('base64');
	} catch (error) {
		console.error('Timestamp encryption error:', error);
		throw error;
	}
}

// Decrypt timestamp using server's private key
function decryptTimestamp(encryptedTimestamp) {
	try {
		// Convert from base64
		const data = Buffer.from(encryptedTimestamp, 'base64');
		
		// Extract IV (first 12 bytes), authTag (last 16 bytes), and encrypted data (middle)
		const iv = data.slice(0, 12);
		const authTag = data.slice(-16);
		const encrypted = data.slice(12, -16);
		
		// Create decipher with authTag
		const decipher = crypto.createDecipheriv('aes-256-gcm', encryption.padKey(SERVER_PASSWRD), iv);
		decipher.setAuthTag(authTag);
		
		let decrypted = decipher.update(encrypted, 'binary', 'utf8');
		decrypted += decipher.final('utf8');
		
		return parseInt(decrypted, 10);
	} catch (error) {
		console.error('Timestamp decryption error:', error);
		throw error;
	}
}

// Handle time sync request - returns encrypted server time
function handleTimeSync(req, res) {
	try {
		const serverTime = Date.now();
		const encryptedTime = encryptTimestamp(serverTime);
		
		console.log(`Time sync request: returning encrypted server time (${serverTime}ms)`);
		
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			encryptedTime: encryptedTime,
			version: 1 // For future compatibility
		}));
	} catch (error) {
		console.error('Time sync error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to sync time' }));
	}
}

// ==================== BOT HANDLERS ====================

function handleAdminCreateBot(req, res) {
	const [requesterId] = (req.headers.authorization || '').split(':');
	if (!handleVerify(req) || requesterId !== CHANNEL_ADMIN_ID) {
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Forbidden' }));
		return;
	}
	const inviteToken = crypto.randomBytes(32).toString('hex');
	const sharedKey = crypto.randomBytes(32).toString('hex');
	const inviteTokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
	const pendingId = 'pending:' + inviteTokenHash;
	botsRegistry.set(pendingId, { pendingId, inviteTokenHash, sharedKey, activated: false, createdAt: Date.now() });
	saveBots();
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ inviteToken, sharedKey }));
}

function handleAdminDeleteBot(req, res, pathname) {
	const [requesterId] = (req.headers.authorization || '').split(':');
	if (!handleVerify(req) || requesterId !== CHANNEL_ADMIN_ID) {
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Forbidden' }));
		return;
	}
	const botId = pathname.split('/')[3];
	if (!botsRegistry.has(botId)) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Bot not found' }));
		return;
	}
	botsRegistry.delete(botId);
	for (const key of botConversations.keys()) {
		if (key.startsWith(botId + ':')) botConversations.delete(key);
	}
	pendingBotMessages.delete(botId);
	saveBots();
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ ok: true }));
}

function handleBotActivate(req, res) {
	const authHeader = req.headers.authorization || '';
	if (!authHeader.startsWith('Invite ')) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Missing invite token' }));
		return;
	}
	const inviteToken = authHeader.slice(7).trim();
	const inviteTokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
	const pendingId = 'pending:' + inviteTokenHash;
	const pendingBot = botsRegistry.get(pendingId);
	if (!pendingBot) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Invalid or used invite token' }));
		return;
	}
	let body = '';
	req.on('data', chunk => { body += chunk; });
	req.on('end', () => {
		try {
			const payload = botDecrypt(body.trim(), pendingBot.sharedKey);
			const { publicKey, name, description, svgIcon, ecdhPublicKey } = payload;
			if (!publicKey || !name) throw new Error('Missing required fields');
			const rawPubKeyBytes = Buffer.from(publicKey, 'base64');
			const botId = crypto.createHash('sha256').update(rawPubKeyBytes).digest('hex');
			if (botsRegistry.has(botId)) {
				res.writeHead(409, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Bot already registered' }));
				return;
			}
			botsRegistry.delete(pendingId);
			botsRegistry.set(botId, {
				botId,
				publicKey,
				ecdhPublicKey: ecdhPublicKey || null,
				name: String(name).slice(0, 64),
				description: String(description || '').slice(0, 256),
				svgIcon: String(svgIcon || '').slice(0, 16384),
				sharedKey: pendingBot.sharedKey,
				activated: true,
				createdAt: Date.now(),
			});
			saveBots();
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ botId }));
		} catch (e) {
			originalError('[Bots] Activation error:', e);
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid payload' }));
		}
	});
}

const BOT_ONLINE_TTL = 20000; // bot considered online if seen within 20s

function handleGetBots(req, res) {
	const now = Date.now();
	const bots = [...botsRegistry.values()]
		.filter(b => b.activated)
		.map(b => ({
			botId: b.botId,
			name: b.name,
			description: b.description,
			svgIcon: b.svgIcon,
			commands: b.commands || [],
			ecdhPublicKey: b.ecdhPublicKey || null,
			online: (now - (botLastSeen.get(b.botId) || 0)) < BOT_ONLINE_TTL,
		}));
	const encrypted = encryption.encryptBlockMessage(
		JSON.stringify({ bots, adminUserId: CHANNEL_ADMIN_ID }),
		SERVER_PASSWRD
	);
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ encrypted }));
}

function handleBotSend(req, res, pathname) {
	if (!handleVerify(req)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized' }));
		return;
	}
	const [userId] = req.headers.authorization.split(':');
	const botId = pathname.split('/')[2];
	const bot = botsRegistry.get(botId);
	if (!bot || !bot.activated) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Bot not found' }));
		return;
	}
	let body = '';
	req.on('data', chunk => { body += chunk; });
	req.on('end', () => {
		try {
			const { content } = JSON.parse(encryption.decryptBlockMessage(body.trim(), SERVER_PASSWRD));
			if (!content || typeof content !== 'string') throw new Error('Missing content');
			const msg = {
				id: crypto.randomBytes(8).toString('hex'),
				role: 'user',
				userId,
				content: content.slice(0, 4096),
				ts: Date.now(),
			};
			const convKey = `${botId}:${userId}`;
			if (!botConversations.has(convKey)) botConversations.set(convKey, []);
			botConversations.get(convKey).push(msg);
			appendBotConvToDisk(convKey, msg);
			if (!pendingBotMessages.has(botId)) pendingBotMessages.set(botId, []);
			pendingBotMessages.get(botId).push(msg);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true, id: msg.id }));
		} catch (e) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid payload' }));
		}
	});
}

function handleBotMessages(req, res, pathname) {
	if (!handleVerify(req)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized' }));
		return;
	}
	const [userId] = req.headers.authorization.split(':');
	const botId = pathname.split('/')[2];
	if (!botsRegistry.has(botId) || !botsRegistry.get(botId).activated) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Bot not found' }));
		return;
	}
	const urlObj = new URL(req.url, 'https://localhost');
	const afterId = urlObj.searchParams.get('after');
	const msgs = botConversations.get(`${botId}:${userId}`) || [];
	let result = msgs;
	if (afterId) {
		const idx = msgs.findLastIndex(m => m.id === afterId);
		result = idx >= 0 ? msgs.slice(idx + 1) : msgs;
	}
	const encrypted = encryption.encryptBlockMessage(
		JSON.stringify({ messages: result.map(m => ({ id: m.id, role: m.role, content: m.content, ts: m.ts, richContent: m.richContent })) }),
		SERVER_PASSWRD
	);
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ encrypted }));
}

function handleBotInbox(req, res, pathname) {
	const bot = verifyBotAuth(req);
	if (!bot) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized' }));
		return;
	}
	const botId = pathname.split('/')[2];
	if (bot.botId !== botId) {
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Forbidden' }));
		return;
	}
	botLastSeen.set(botId, Date.now());
	const urlObj = new URL(req.url, 'https://localhost');
	const afterId = urlObj.searchParams.get('after');
	const pending = pendingBotMessages.get(botId) || [];
	let result = pending;
	if (afterId) {
		const idx = pending.findLastIndex(m => m.id === afterId);
		result = idx >= 0 ? pending.slice(idx + 1) : pending;
	}
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ encrypted: botEncrypt({ messages: result }, bot.sharedKey) }));
}

function handleBotReply(req, res, pathname) {
	const bot = verifyBotAuth(req);
	if (!bot) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized' }));
		return;
	}
	const botId = pathname.split('/')[2];
	if (bot.botId !== botId) {
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Forbidden' }));
		return;
	}
	botLastSeen.set(botId, Date.now());
	let body = '';
	req.on('data', chunk => { body += chunk; });
	req.on('end', () => {
		try {
			const payload = botDecrypt(body.trim(), bot.sharedKey);
			const { userId, content, richContent } = payload;
			if (!userId || !content) throw new Error('Missing fields');
			const msg = {
				id: crypto.randomBytes(8).toString('hex'),
				role: 'bot',
				content: String(content).slice(0, 4096),
				ts: Date.now(),
			};
			if (richContent) msg.richContent = richContent;
			const convKey = `${botId}:${userId}`;
			if (!botConversations.has(convKey)) botConversations.set(convKey, []);
			botConversations.get(convKey).push(msg);
			appendBotConvToDisk(convKey, msg);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true, id: msg.id }));
		} catch (e) {
			originalError('[Bots] Reply error:', e);
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid payload' }));
		}
	});
}

function handleBotSetCommands(req, res, pathname) {
	const bot = verifyBotAuth(req);
	if (!bot) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized' }));
		return;
	}
	const botId = pathname.split('/')[2];
	if (bot.botId !== botId) {
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Forbidden' }));
		return;
	}
	let body = '';
	req.on('data', chunk => { body += chunk; });
	req.on('end', () => {
		try {
			const { commands } = botDecrypt(body.trim(), bot.sharedKey);
			if (!Array.isArray(commands)) throw new Error('commands must be array');
			const record = botsRegistry.get(botId);
			record.commands = commands.slice(0, 50).map(c => ({
				name: String(c.name || '').slice(0, 32),
				description: String(c.description || '').slice(0, 128),
			}));
			saveBots();
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true }));
		} catch (e) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid payload' }));
		}
	});
}

function handleBotJoinChat(req, res, pathname) {
	if (!handleVerify(req)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized' }));
		return;
	}
	const parts = pathname.split('/');
	const botId = parts[2];
	const chatHandle = decodeURIComponent(parts[4]);
	const bot = botsRegistry.get(botId);
	if (!bot || !bot.activated) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Bot not found' }));
		return;
	}
	let body = '';
	req.on('data', chunk => { body += chunk; });
	req.on('end', () => {
		try {
			const { encryptedKeyBlob, ephemeralPubKey } = JSON.parse(body);
			if (!encryptedKeyBlob || !ephemeralPubKey) throw new Error('Missing fields');
			const key = `${botId}:${chatHandle}`;
			botChatMemberships.set(key, { botId, chatHandle, encryptedKeyBlob, ephemeralPubKey });
			saveBotMemberships();
			if (!pendingBotMessages.has(botId)) pendingBotMessages.set(botId, []);
			pendingBotMessages.get(botId).push({
				id: crypto.randomBytes(8).toString('hex'),
				type: 'join',
				chatHandle,
				encryptedKeyBlob,
				ephemeralPubKey,
				ts: Date.now(),
			});
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true }));
		} catch (e) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid request' }));
		}
	});
}

function handleBotLeaveChat(req, res, pathname) {
	if (!handleVerify(req)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized' }));
		return;
	}
	const parts = pathname.split('/');
	const botId = parts[2];
	const chatHandle = decodeURIComponent(parts[4]);
	const key = `${botId}:${chatHandle}`;
	if (!botChatMemberships.has(key)) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Bot not in this chat' }));
		return;
	}
	botChatMemberships.delete(key);
	saveBotMemberships();
	if (!pendingBotMessages.has(botId)) pendingBotMessages.set(botId, []);
	pendingBotMessages.get(botId).push({
		id: crypto.randomBytes(8).toString('hex'),
		type: 'leave',
		chatHandle,
		ts: Date.now(),
	});
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ ok: true }));
}

function handleGetChatBots(req, res, pathname) {
	if (!handleVerify(req)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized' }));
		return;
	}
	const chatHandle = decodeURIComponent(pathname.split('/')[2]);
	const bots = [...botChatMemberships.values()]
		.filter(m => m.chatHandle === chatHandle)
		.map(m => {
			const bot = botsRegistry.get(m.botId);
			if (!bot || !bot.activated) return null;
			return { botId: bot.botId, name: bot.name, svgIcon: bot.svgIcon };
		})
		.filter(Boolean);
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ bots }));
}

function handleBotSendToChat(req, res, pathname) {
	const bot = verifyBotAuth(req);
	if (!bot) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized' }));
		return;
	}
	const parts = pathname.split('/');
	const botId = parts[2];
	const chatHandle = decodeURIComponent(parts[4]);
	if (bot.botId !== botId) {
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Forbidden' }));
		return;
	}
	if (!botChatMemberships.has(`${botId}:${chatHandle}`)) {
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Bot not in this chat' }));
		return;
	}
	botLastSeen.set(botId, Date.now());
	let body = '';
	req.on('data', chunk => { body += chunk; });
	req.on('end', () => {
		try {
			const payload = botDecrypt(body.trim(), bot.sharedKey);
			const { encryptedContent, encryptedName, encryptedRichContent } = payload;
			if (!encryptedContent || !encryptedName) throw new Error('Missing fields');
			const encryptedTimestamp = encryptTimestamp(Date.now());
			const message = {
				encryptedName,
				encryptedContent,
				encryptedTimestamp,
				type: 'text',
				id: encryptedTimestamp,
				keyFp: null,
				senderUserId: botId,
				reactions: {},
				edits: [],
				replyTo: null,
				encryptedRichContent: encryptedRichContent || null,
			};
			if (!messagesStorage.has(chatHandle)) messagesStorage.set(chatHandle, []);
			messagesStorage.get(chatHandle).push(message);
			appendMessageToDisk(chatHandle, message, encryptedContent, false);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true, id: message.id }));
		} catch (e) {
			originalError('[Bots] sendToChat error:', e);
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid payload' }));
		}
	});
}

function handleBotSetTyping(req, res, pathname) {
	const bot = verifyBotAuth(req);
	if (!bot) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
	const parts = pathname.split('/');
	const botId = parts[2];
	const chatHandle = decodeURIComponent(parts[4]);
	if (bot.botId !== botId || !botChatMemberships.has(`${botId}:${chatHandle}`)) {
		res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return;
	}
	let body = '';
	req.on('data', chunk => { body += chunk; });
	req.on('end', () => {
		try {
			const { typing } = botDecrypt(body.trim(), bot.sharedKey);
			const key = `${botId}:${chatHandle}`;
			if (typing) {
				botTypingState.set(key, { name: bot.name, ts: Date.now() });
			} else {
				botTypingState.delete(key);
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true }));
		} catch (e) {
			res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid payload' }));
		}
	});
}

// ==================== CHANNEL HANDLERS ====================

function handleGetChannels(req, res) {
	const payload = CHANNELS.map(c => ({
		handle: c.handle,
		displayName: c.displayName,
		type: c.type,
		pinned: c.pinned,
		adminUserId: c.adminUserId,
	}));
	const encrypted = encryption.encryptBlockMessage(JSON.stringify(payload), SERVER_PASSWRD);
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ encrypted }));
}

function handleChannelView(req, res, pathname) {
	const parts = pathname.split('/'); // ['', 'channels', handle, 'view']
	const channelHandle = parts[2];
	if (!CHANNEL_MAP.has(channelHandle)) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Channel not found' }));
		return;
	}
	const [viewUserId] = (req.headers.authorization || '').split(':');
	let body = '';
	req.on('data', chunk => { body += chunk.toString(); });
	req.on('end', () => {
		try {
			const { messageIds } = JSON.parse(body);
			if (Array.isArray(messageIds) && viewUserId) {
				for (const msgId of messageIds) {
					if (!channelViewCounts.has(msgId)) channelViewCounts.set(msgId, new Set());
					channelViewCounts.get(msgId).add(viewUserId);
				}
			}
			res.writeHead(204);
			res.end();
		} catch (e) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid data' }));
		}
	});
}

// ==================== VOICE CALL HANDLERS ====================

function handleCallInitiate(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];

	if (!chatHandle) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle is required' }));
		return;
	}

	const [callerId] = req.headers.authorization.split(':');

	// Channel guard — only admin may initiate calls
	const callChannel = CHANNEL_MAP.get(chatHandle);
	if (callChannel && callerId !== callChannel.adminUserId) {
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Calls are not supported in this channel' }));
		return;
	}

	// Check if there's already an active/ringing call in this chat
	const existingCallId = pendingCalls.get(chatHandle);
	if (existingCallId) {
		const existingCall = activeCalls.get(existingCallId);
		if (existingCall && (existingCall.status === 'RINGING' || existingCall.status === 'ACTIVE')) {
			res.writeHead(409, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'A call is already active in this chat' }));
			return;
		}
	}

	const callSessionId = `call-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

	const callSession = {
		id: callSessionId,
		chatHandle,
		initiatorId: callerId,
		participants: [callerId],
		status: 'ACTIVE',
		createdAt: Date.now(),
		startedAt: Date.now(),
		endedAt: null,
		lastHeartbeat: new Map([[callerId, Date.now()]])
	};

	// Initialize audio buffer for initiator
	callAudioBuffers.set(callSessionId, new Map([[callerId, { chunks: [], seq: 0, initChunk: null }]]));
	callVideoBuffers.set(callSessionId, new Map());
	callSession.videoParticipants = [];

	activeCalls.set(callSessionId, callSession);
	pendingCalls.set(chatHandle, callSessionId);

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ callSessionId, status: 'ACTIVE', participants: [callerId] }));
}

function handleCallPoll(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];

	if (!chatHandle) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle is required' }));
		return;
	}

	const [userId] = req.headers.authorization.split(':');

	const callId = pendingCalls.get(chatHandle);
	if (!callId) {
		res.writeHead(204);
		res.end();
		return;
	}

	const call = activeCalls.get(callId);
	if (!call || call.status === 'ENDED') {
		res.writeHead(204);
		res.end();
		return;
	}

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({
		callSessionId: call.id,
		status: call.status,
		initiatorId: call.initiatorId,
		participants: call.participants,
		isParticipant: call.participants.includes(userId),
		videoParticipants: call.videoParticipants || []
	}));
}

function handleCallJoin(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];
	const callId = parts[4];

	if (!chatHandle || !callId) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle and call ID are required' }));
		return;
	}

	const [userId] = req.headers.authorization.split(':');

	const call = activeCalls.get(callId);
	if (!call) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Call not found' }));
		return;
	}

	if (call.status === 'ENDED') {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Call has ended' }));
		return;
	}

	// Already a participant - idempotent
	if (call.participants.includes(userId)) {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ callSessionId: callId, status: call.status, participants: call.participants }));
		return;
	}

	if (call.participants.length >= CALL_MAX_PARTICIPANTS) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Call is full (max 10 participants)' }));
		return;
	}

	call.participants.push(userId);
	call.lastHeartbeat.set(userId, Date.now());

	// Initialize audio buffer for this participant
	const buffers = callAudioBuffers.get(callId);
	if (buffers) buffers.set(userId, { chunks: [], seq: 0, initChunk: null });

	const vBuffers = callVideoBuffers.get(callId);
	if (vBuffers && !vBuffers.has(userId)) vBuffers.set(userId, { chunks: [], seq: 0, initChunk: null });

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ callSessionId: callId, status: call.status, participants: call.participants }));
}

function handleCallReject(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];
	const callId = parts[4];

	if (!chatHandle || !callId) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle and call ID are required' }));
		return;
	}

	const call = activeCalls.get(callId);
	if (!call) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Call not found' }));
		return;
	}

	// Individual dismiss - does not end the call for other participants
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ callSessionId: callId, status: call.status }));
}

function handleCallLeave(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];
	const callId = parts[4];

	if (!chatHandle || !callId) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle and call ID are required' }));
		return;
	}

	const [userId] = req.headers.authorization.split(':');

	const call = activeCalls.get(callId);
	if (!call) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Call not found' }));
		return;
	}

	call.participants = call.participants.filter(p => p !== userId);

	// Clean up this user's audio buffer
	const buffers = callAudioBuffers.get(callId);
	if (buffers) buffers.delete(userId);
	const vBuffers = callVideoBuffers.get(callId);
	if (vBuffers) vBuffers.delete(userId);
	if (call.videoParticipants) call.videoParticipants = call.videoParticipants.filter(p => p !== userId);

	if (call.participants.length === 0) {
		call.status = 'ENDED';
		call.endedAt = Date.now();
		pendingCalls.delete(chatHandle);
	}

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ callSessionId: callId, status: call.status, participants: call.participants }));
}

function handleCallHeartbeat(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];
	const callId = parts[4];

	if (!chatHandle || !callId) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle and call ID are required' }));
		return;
	}

	const [userId] = req.headers.authorization.split(':');
	const call = activeCalls.get(callId);

	if (!call || call.status === 'ENDED') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ callStatus: 'ENDED' }));
		return;
	}

	if (!call.participants.includes(userId)) {
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not a participant' }));
		return;
	}

	call.lastHeartbeat.set(userId, Date.now());

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ callStatus: call.status }));
}

function handleCallSendAudio(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];
	const callId = parts[4];

	if (!chatHandle || !callId) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle and call ID are required' }));
		return;
	}

	const [userId] = req.headers.authorization.split(':');

	const call = activeCalls.get(callId);
	if (!call || call.status !== 'ACTIVE') {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Call is not active' }));
		return;
	}

	const buffers = callAudioBuffers.get(callId);
	const userBuffer = buffers?.get(userId);
	if (!userBuffer) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Audio buffer not initialized' }));
		return;
	}

	let body = '';
	req.on('data', (chunk) => {
		body += chunk.toString();
	});

	req.on('end', () => {
		try {
			const { audioData } = JSON.parse(body);

			const seq = userBuffer.seq++;
			userBuffer.chunks.push({ seq, audioData, timestamp: Date.now() });

			// Persist the first chunk as the MSE init segment for late joiners
			if (seq === 0) userBuffer.initChunk = { seq, audioData };

			// Circular buffer - keep last N chunks
			while (userBuffer.chunks.length > CALL_AUDIO_BUFFER_SIZE) {
				userBuffer.chunks.shift();
			}

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ seq }));
		} catch (err) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid request body' }));
		}
	});
}

function handleCallReceiveAudio(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];
	const callId = parts[4];

	if (!chatHandle || !callId) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle and call ID are required' }));
		return;
	}

	const [userId] = req.headers.authorization.split(':');
	const parsedUrl = url.parse(req.url, true);
	const fromUserId = parsedUrl.query.fromUserId;
	const afterSeq = parseInt(parsedUrl.query.afterSeq || '-1', 10);
	const maxWaitMs = parseInt(parsedUrl.query.maxWaitMs || '500', 10);

	if (!fromUserId) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'fromUserId is required' }));
		return;
	}

	const call = activeCalls.get(callId);
	if (!call) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Call not found' }));
		return;
	}

	const buffers = callAudioBuffers.get(callId);
	const senderBuffer = buffers?.get(fromUserId);
	if (!senderBuffer) {
		res.writeHead(204);
		res.end();
		return;
	}

	const chunks = senderBuffer.chunks;
	const nextExpectedSeq = afterSeq + 1;

	// Helper: return oldest available chunk if seq is too old (late joiner catch-up)
	function serveOldestChunk(chunkArr, currentCall) {
		const chunk = chunkArr[0];
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ seq: chunk.seq, audioData: chunk.audioData, callStatus: currentCall.status }));
	}

	// Late joiner: serve init chunk when seq 0 is needed but not in circular buffer
	if (nextExpectedSeq === 0 && senderBuffer.initChunk && chunks.findIndex(c => c.seq === 0) === -1) {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ seq: 0, audioData: senderBuffer.initChunk.audioData, callStatus: call.status }));
		return;
	}

	// If requested seq is behind the buffer, skip ahead to oldest available chunk
	if (chunks.length > 0 && chunks[0].seq > nextExpectedSeq) {
		serveOldestChunk(chunks, call);
		return;
	}

	// Find the EXACT chunk with the next expected sequence
	const chunkIndex = chunks.findIndex(c => c.seq === nextExpectedSeq);

	if (chunkIndex !== -1) {
		const chunk = chunks[chunkIndex];
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			seq: chunk.seq,
			audioData: chunk.audioData,
			callStatus: call.status
		}));
		return;
	}

	// Long-poll: wait for the next chunk in sequence
	const startTime = Date.now();
	const checkInterval = setInterval(() => {
		const elapsed = Date.now() - startTime;

		// Check if call ended
		const currentCall = activeCalls.get(callId);
		if (!currentCall || currentCall.status === 'ENDED') {
			clearInterval(checkInterval);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ callStatus: 'ENDED' }));
			return;
		}

		// Late joiner: serve init chunk when seq 0 is needed but not in circular buffer
		if (nextExpectedSeq === 0 && senderBuffer.initChunk && chunks.findIndex(c => c.seq === 0) === -1) {
			clearInterval(checkInterval);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ seq: 0, audioData: senderBuffer.initChunk.audioData, callStatus: currentCall.status }));
			return;
		}

		// Skip ahead if buffer has newer chunks (late joiner)
		if (chunks.length > 0 && chunks[0].seq > nextExpectedSeq) {
			clearInterval(checkInterval);
			serveOldestChunk(chunks, currentCall);
			return;
		}

		// Look for the exact next sequence number
		const newChunkIndex = chunks.findIndex(c => c.seq === nextExpectedSeq);
		if (newChunkIndex !== -1) {
			clearInterval(checkInterval);
			const newChunk = chunks[newChunkIndex];
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				seq: newChunk.seq,
				audioData: newChunk.audioData,
				callStatus: currentCall.status
			}));
			return;
		}

		if (elapsed >= maxWaitMs) {
			clearInterval(checkInterval);
			res.writeHead(204);
			res.end();
		}
	}, 50);
}

function handleCallSendVideo(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];
	const callId = parts[4];

	if (!chatHandle || !callId) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle and call ID are required' }));
		return;
	}

	const [userId] = req.headers.authorization.split(':');

	const call = activeCalls.get(callId);
	if (!call || call.status !== 'ACTIVE') {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Call is not active' }));
		return;
	}

	const vBuffers = callVideoBuffers.get(callId);
	const userBuffer = vBuffers?.get(userId);
	if (!userBuffer) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Video buffer not initialized' }));
		return;
	}

	let body = '';
	req.on('data', (chunk) => {
		body += chunk.toString();
	});

	req.on('end', () => {
		try {
			const { videoData } = JSON.parse(body);

			const seq = userBuffer.seq++;
			userBuffer.chunks.push({ seq, videoData, timestamp: Date.now() });

			// Persist the first chunk as the MSE init segment for late joiners
			if (seq === 0) userBuffer.initChunk = { seq, videoData };

			// Add to videoParticipants if first chunk
			if (seq === 0 && call.videoParticipants && !call.videoParticipants.includes(userId)) {
				call.videoParticipants.push(userId);
			}

			// Circular buffer - keep last N chunks
			while (userBuffer.chunks.length > CALL_VIDEO_BUFFER_SIZE) {
				userBuffer.chunks.shift();
			}

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ seq }));
		} catch (err) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid request body' }));
		}
	});
}

function handleCallReceiveVideo(req, res, pathname) {
	const parts = pathname.split('/');
	const chatHandle = parts[3];
	const callId = parts[4];

	if (!chatHandle || !callId) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Chat handle and call ID are required' }));
		return;
	}

	const [userId] = req.headers.authorization.split(':');
	const parsedUrl = url.parse(req.url, true);
	const fromUserId = parsedUrl.query.fromUserId;
	const afterSeq = parseInt(parsedUrl.query.afterSeq || '-1', 10);
	const maxWaitMs = parseInt(parsedUrl.query.maxWaitMs || '100', 10);

	if (!fromUserId) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'fromUserId is required' }));
		return;
	}

	const call = activeCalls.get(callId);
	if (!call) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Call not found' }));
		return;
	}

	const vBuffers = callVideoBuffers.get(callId);
	const senderBuffer = vBuffers?.get(fromUserId);
	if (!senderBuffer) {
		res.writeHead(204);
		res.end();
		return;
	}

	const chunks = senderBuffer.chunks;
	const nextExpectedSeq = afterSeq + 1;

	// Helper: return oldest available chunk if seq is too old (late joiner catch-up)
	function serveOldestChunk(chunkArr, currentCall) {
		const chunk = chunkArr[0];
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ seq: chunk.seq, videoData: chunk.videoData, callStatus: currentCall.status }));
	}

	// Late joiner: serve init chunk when seq 0 is needed but not in circular buffer
	if (nextExpectedSeq === 0 && senderBuffer.initChunk && chunks.findIndex(c => c.seq === 0) === -1) {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ seq: 0, videoData: senderBuffer.initChunk.videoData, callStatus: call.status }));
		return;
	}

	// If requested seq is behind the buffer, skip ahead to oldest available chunk
	if (chunks.length > 0 && chunks[0].seq > nextExpectedSeq) {
		serveOldestChunk(chunks, call);
		return;
	}

	// Find the EXACT chunk with the next expected sequence
	const chunkIndex = chunks.findIndex(c => c.seq === nextExpectedSeq);

	if (chunkIndex !== -1) {
		const chunk = chunks[chunkIndex];
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			seq: chunk.seq,
			videoData: chunk.videoData,
			callStatus: call.status
		}));
		return;
	}

	// Long-poll: wait for the next chunk in sequence
	const startTime = Date.now();
	const checkInterval = setInterval(() => {
		const elapsed = Date.now() - startTime;

		// Check if call ended
		const currentCall = activeCalls.get(callId);
		if (!currentCall || currentCall.status === 'ENDED') {
			clearInterval(checkInterval);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ callStatus: 'ENDED' }));
			return;
		}

		// Late joiner: serve init chunk when seq 0 is needed but not in circular buffer
		if (nextExpectedSeq === 0 && senderBuffer.initChunk && chunks.findIndex(c => c.seq === 0) === -1) {
			clearInterval(checkInterval);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ seq: 0, videoData: senderBuffer.initChunk.videoData, callStatus: currentCall.status }));
			return;
		}

		// Skip ahead if buffer has newer chunks (late joiner)
		if (chunks.length > 0 && chunks[0].seq > nextExpectedSeq) {
			clearInterval(checkInterval);
			serveOldestChunk(chunks, currentCall);
			return;
		}

		// Look for the exact next sequence number
		const newChunkIndex = chunks.findIndex(c => c.seq === nextExpectedSeq);
		if (newChunkIndex !== -1) {
			clearInterval(checkInterval);
			const newChunk = chunks[newChunkIndex];
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				seq: newChunk.seq,
				videoData: newChunk.videoData,
				callStatus: currentCall.status
			}));
			return;
		}

		if (elapsed >= maxWaitMs) {
			clearInterval(checkInterval);
			res.writeHead(204);
			res.end();
		}
	}, 50);
}

// Get MIME type for file
function getMimeType(filename) {
	const ext = path.extname(filename).toLowerCase();
	const mimeTypes = {
		'.html': 'text/html',
		'.css': 'text/css',
		'.js': 'application/javascript',
		'.png': 'image/png',
		'.jpg': 'image/jpeg',
		'.jpeg': 'image/jpeg',
		'.gif': 'image/gif',
		'.svg': 'image/svg+xml',
		'.ico': 'image/x-icon',
	};

	return mimeTypes[ext] || 'application/octet-stream';
}

server.on('error', (err) => {
	console.error(`[${new Date().toISOString()}] Server error:`, err);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
	console.log(
		`[${new Date().toISOString()}] Server running on http://localhost:${PORT}`,
	);
	console.log('Chat app ready for use!');
	console.log('==============================================');
	console.log('To test:');
	console.log('1. Open browser to http://localhost:3000');
	console.log('2. Enter a chat handle (e.g., "my-chat")');
	console.log('3. Enter your name');
	console.log('4. Enter an encryption key (shared with the other user)');
	console.log('5. Click "Join Chat"');
	console.log('==============================================');
});

// Graceful shutdown
process.on('SIGINT', () => {
	console.log('\nShutting down server...');
	process.exit(0);
});

process.on('uncaughtException', (err) => {
	console.error(`[${new Date().toISOString()}] Uncaught exception:`, err);
});

process.on('unhandledRejection', (reason) => {
	console.error(`[${new Date().toISOString()}] Unhandled rejection:`, reason);
});
