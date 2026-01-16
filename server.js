const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const Encryption = require('./encryption');
const crypto = require('crypto');

// In-memory storage for messages (in production, use a database)
const messagesStorage = new Map();

// In-memory storage for user heartbeats and online status
// Structure: chatHandle -> userId -> { lastHeartbeat, userName }
const userHeartbeats = new Map();

// Grace period for marking users as offline (in milliseconds)
const OFFLINE_GRACE_PERIOD = 30000; // 30 seconds
const OFFLINE_THRESHOLD = 15000; // 15 seconds before grace period

const tlsOptions = {
	key: fs.readFileSync(path.join(__dirname, 'cert', 'key.pem')),
	cert: fs.readFileSync(path.join(__dirname, 'cert', 'cert.pem')),
};

const encryption = new Encryption();
const SERVER_PASSWRD = 'sadra1378';

// Create HTTP server
const server = https.createServer(tlsOptions, (req, res) => {
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

	// Serve static files (.js, .css, images) without authentication
	if (pathname.endsWith('.js') || pathname.endsWith('.css') || 
	    pathname.endsWith('.png') || pathname.endsWith('.jpg') || 
	    pathname.endsWith('.jpeg') || pathname.endsWith('.gif') || 
	    pathname.endsWith('.svg') || pathname.endsWith('.ico')) {
		const fileName = path.basename(pathname); // Extract filename from path
		const filePath = path.join(__dirname, fileName); // Join with just the filename
		const contentType = getMimeType(filePath);
		
		fs.readFile(filePath, (err, data) => {
			if (err) {
				console.log(`Static file not found: ${filePath}`);
				res.writeHead(404, { 'Content-Type': 'text/plain' });
				res.end('File not found');
				return;
			}
			
			console.log(`Serving static file: ${pathname} -> ${filePath}`);
			res.writeHead(200, { 'Content-Type': contentType });
			res.end(data);
		});
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
	if (req.method === 'GET' && pathname.startsWith('/messages/')) {
		console.log('Handling GET /messages/');
		handleGetMessages(req, res, pathname);
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

	// Default response
	console.log('404 Not Found');
	res.writeHead(404, { 'Content-Type': 'text/plain' });
	res.end('Not Found');
});

function handleVerify(req) {
	const authorization = req.headers.authorization;
	if (!authorization) {
		return false;
	}

	// userId:sign
	// sign = hash(privateKey + timeBucket)
	// timeBucket = current time rounded down to nearest 5 seconds

	const [userId, signature] = authorization.split(':');
	const keys = encryption.keys.get(userId);

	if(!keys) {
		return false;
	}

	const [publicKey, privateKey] = keys;

	// Check multiple time buckets to tolerate clock skew and network latency
	// With proper time sync, we only need to check current bucket
	// But as a fallback for clients without time sync, check up to 60 seconds of buckets
	// 12 buckets × 5 seconds = 60 seconds of tolerance
	const now = Date.now();
	const timeBuckets = [];
	
	// Generate 12 time buckets (0-60 seconds in the past)
	for (let i = 0; i < 12; i++) {
		timeBuckets.push(now - (i * 5000) - (now % 5000));
	}

	// Try each time bucket
	for (const timeBucket of timeBuckets) {
		const expectedSign = crypto
			.createHash('sha256')
			.update(`${privateKey}:${timeBucket}`)
			.digest("hex");
		
		if (signature === expectedSign) {
			console.log(`✅ Authentication successful for userId: ${userId} (timeBucket: ${timeBucket}, offset: ${now - timeBucket}ms)`);
			return true;
		}
	}

	// If none matched, log for debugging
	console.log(`❌ Authentication failed for userId: ${userId}`);
	console.log(`   Received signature: ${signature.substring(0, 16)}...`);
	console.log(`   Current time bucket: ${now - (now % 5000)}`);
	console.log(`   Checked ${timeBuckets.length} time buckets (±60 seconds)`);
	return false;

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

	// If an "after" id is provided, filter out earlier messages
	let filteredMessages;
	if (after) {
		filteredMessages = allMessages.filter((msg) => msg.id > after);
		console.log(
			`Filtering after ${after}: ${filteredMessages.length} new messages`,
		);
	} else {
		filteredMessages = allMessages;
	}

	// Send the (possibly filtered) list
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(filteredMessages));
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
			// messageData should now contain `encryptedName`, `content`, `timestamp`, and `sender`

			// Create message object – keep the encrypted name
			const message = {
				sender: messageData.sender,
				encryptedName: messageData.encryptedName,
				encryptedContent: messageData.content,
				timestamp: messageData.timestamp,
				type: messageData.type || 'text',
				id: messageData.timestamp, // <-- new field
			};

			// Store message
			if (!messagesStorage.has(chatHandle)) {
				messagesStorage.set(chatHandle, []);
			}
			messagesStorage.get(chatHandle).push(message);
			console.log(`Stored message for chat handle: ${chatHandle}`);

			// Keep only last 100 messages
			const chatMessages = messagesStorage.get(chatHandle);
			if (chatMessages.length > 100) {
				chatMessages.shift();
				console.log(`Trimmed messages for chat handle: ${chatHandle}`);
			}

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true }));
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
			const { userName } = heartbeatData;

			const now = Date.now();

			// Initialize chat entry if needed
			if (!userHeartbeats.has(chatHandle)) {
				userHeartbeats.set(chatHandle, new Map());
			}

			const chatUsers = userHeartbeats.get(chatHandle);

			// Clean up expired heartbeats (grace period passed)
			for (const [uid, userData] of chatUsers.entries()) {
				if (now - userData.lastHeartbeat > OFFLINE_GRACE_PERIOD) {
					chatUsers.delete(uid);
					console.log(`Removed offline user ${uid} from chat ${chatHandle}`);
				}
			}

			// Update the current user's heartbeat
			chatUsers.set(userId, {
				lastHeartbeat: now,
				userName: userName || 'Unknown'
			});

			console.log(`Heartbeat from ${userId} (${userName}) in chat ${chatHandle}`);

			// Build online users header
			// Format: userName|status,userName|status,...
			const onlineUsersArray = Array.from(chatUsers.entries()).map(([uid, userData]) => {
				let status = 'online';
				const timeSinceHeartbeat = now - userData.lastHeartbeat;

				if (timeSinceHeartbeat > OFFLINE_THRESHOLD) {
					status = 'offline_recent';
				}

				return `${userData.userName}|${status}`;
			});

			const onlineUsersHeader = onlineUsersArray.join(',');

			console.log(`Online users in ${chatHandle}: ${onlineUsersHeader}`);

			// Encode header to handle Persian/non-ASCII characters
			const encodedOnlineUsersHeader = encodeURIComponent(onlineUsersHeader);

			res.writeHead(200, {
				'Content-Type': 'application/json',
				'X-Online-Users': encodedOnlineUsersHeader
			});
			res.end(JSON.stringify({ success: true }));
		} catch (error) {
			console.error('Error processing heartbeat:', error);
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid heartbeat data' }));
		}
	});
}

// Serve static files
function serveFile(res, filePath, contentType) {
	console.log(`Attempting to serve file: ${filePath}`);

	fs.readFile(filePath, async (err, data) => {
		if (err) {
			console.error(`Error reading file ${filePath}:`, err);
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			res.end('File not found');
			return;
		}

		const userId = encryption.getKeyPairs();
		const privateKey = encryption.keys.get(userId)[1];
		
		// Include server timestamp in the encrypted data
		const serverData = {
			userId: userId,
			privateKey: privateKey,
			timestamp: Date.now()
		};
		
		const encrypted = await encryption.encryptBlockMessage(
			JSON.stringify(serverData),
			SERVER_PASSWRD,
		);

		// create the key with index attached to it as prefix, then encrypt block cipher and put as value here
		let text = data.toString();
		text = text.replace(
			'{KEY_PLACE_HOLDER}',
			`<input type="text" name="" id="public_key" value="${encrypted}" style="display: none;">`,
		);

		console.log(`Successfully served file: ${filePath}`);
		res.writeHead(200, { 'Content-Type': contentType });
		res.end(Buffer.from(text));
	});

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

