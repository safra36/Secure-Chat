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
const pendingCalls = new Map();      // chatHandle -> callSessionId

// Voice call constants
const CALL_RING_TIMEOUT = 30000;     // 30s to answer
const CALL_MAX_DURATION = 7200000;   // 2h max
const CALL_AUDIO_BUFFER_SIZE = 20;   // Keep last 20 chunks per user (circular)
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
	res.writeHead = (code, headers = {}) => { return _wh(code, { 'X-Server-Build': SERVER_BUILD_HEADER, ...headers }); };

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
			// and collect reaction patches to apply after.
			const messageMap = new Map(); // id → { msg, content, isCompressed }
			const reactionPatches = [];   // { messageId, reactions }

			for (const line of rawLines) {
				try {
					const entry = JSON.parse(line);
					if (entry.type === 'reaction_patch') {
						reactionPatches.push(entry);
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

			// Apply reaction patches to their messages
			for (const patch of reactionPatches) {
				const entry = messageMap.get(patch.messageId);
				if (entry) {
					entry.msg.reactions = patch.reactions;
					if (patch.lastUpdated) entry.msg.lastUpdated = patch.lastUpdated;
				}
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
		.update(message.senderUserId + requestingUserId)
		.digest('hex').slice(0, 16);
	return {
		id: message.id,
		encryptedName: message.encryptedName,
		encryptedContent: message.encryptedContent,
		encryptedTimestamp: message.encryptedTimestamp,
		type: message.type,
		stickerId: message.stickerId || null,
		replyTo: message.replyTo || null,
		isEdited: (message.edits || []).length > 0,
		reactions: transformedReactions,
		colorToken
	};
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
	if (after) {
		try {
			afterTimestamp = decryptTimestamp(after);
			filteredMessages = allMessages.filter((msg) => {
				try {
					const msgTimestamp = decryptTimestamp(msg.encryptedTimestamp);
					// Include new messages OR recently updated messages (reaction/edit after cursor)
					return msgTimestamp > afterTimestamp || ((msg.lastUpdated || 0) > afterTimestamp);
				} catch (err) {
					console.warn('Skipping message with invalid timestamp:', err);
					return false;
				}
			});
			console.log(
				`Filtering after timestamp ${afterTimestamp}: ${filteredMessages.length} new messages`,
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
	if (afterTimestamp !== null && filteredMessages.length > 0) {
		let maxTime = afterTimestamp;
		filteredMessages.forEach(msg => {
			try {
				const t = decryptTimestamp(msg.encryptedTimestamp);
				if (t > maxTime) maxTime = t;
			} catch {}
			if ((msg.lastUpdated || 0) > maxTime) maxTime = msg.lastUpdated;
		});
		if (maxTime > afterTimestamp) nextCursor = encryptTimestamp(maxTime);
	}

	// Send the (filtered and sorted) list, serialized for client
	res.writeHead(200, { 'Content-Type': 'application/json' });
	if (afterTimestamp !== null) {
		res.end(JSON.stringify({ messages: serializedMessages, nextCursor }));
	} else {
		res.end(JSON.stringify(serializedMessages));
	}
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
				senderUserId,          // stored server-side only, never sent to clients
				reactions: {},         // encryptedEmoji → { userIds: [], encryptedUserNames: {} }
				edits: [],             // [{ encryptedEditTimestamp }]
				replyTo: messageData.replyTo || null, // { messageId, encryptedPreview, encryptedSenderName }
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

			res.writeHead(200, responseHeaders);
			res.end(JSON.stringify({ success: true }));
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
			const { sessionId, encryptedName, encryptedTimestamp, messageType, isCompressed, encryptedMeta, stickerId, replyTo } = completeData;
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

			// Create message object with encrypted timestamp as ID (consistent with text messages)
			const message = {
				sender: null, // Will use encryptedName for sender
				encryptedName: encryptedName,
				encryptedContent: null, // Content is stored separately, not in message
				encryptedTimestamp: encryptedTimestamp, // Encrypted timestamp for consistency
				type: messageType || 'file',
				id: encryptedTimestamp, // Use encrypted timestamp as ID
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
	const entries = [];
	for (const line of rawLines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed && parsed.msg) entries.push(parsed);
		} catch (e) {}
	}

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
		isParticipant: call.participants.includes(userId)
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
