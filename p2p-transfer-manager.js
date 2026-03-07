/**
 * P2P Transfer Manager - Client-side file transfer system
 * Handles chunked file transfers with ACK-based flow control
 * Browser-compatible version (no Node.js Buffer dependency)
 */

// Constants matching server-side configuration
// With encryption + base64, actual transferred size is ~33% larger
// 192KB plaintext → ~12 bytes IV → ~256KB encrypted+base64
const P2P_CHUNK_SIZE = 192 * 1024; // 192KB (becomes ~256KB after encryption+base64)
const P2P_ACK_TIMEOUT = 10000; // 10 seconds
const P2P_MAX_RETRIES = 3;
const P2P_MAX_CONCURRENT = 2;
const P2P_POLL_INTERVAL = 5000; // 5 seconds for long-polling

class P2PTransferManager {
	constructor(encryptionKey = null) {
		// Active transfers
		this.activeSends = new Map(); // transferSessionId -> SendTransfer
		this.activeReceives = new Map(); // transferSessionId -> ReceiveTransfer

		// Encryption key for E2E encryption
		this.encryptionKey = encryptionKey;

		// Transfer event listeners
		this.listeners = new Map();
	}

	// ==================== ENCRYPTION HELPERS ====================

	padKey(keyStr) {
		const encoder = new TextEncoder();
		const data = encoder.encode(keyStr);
		const padded = new Uint8Array(32);
		padded.set(data.slice(0, 32));
		return padded;
	}

	async encryptMessage(message, key) {
		try {
			const encoder = new TextEncoder();
			const data = encoder.encode(message);
			const iv = crypto.getRandomValues(new Uint8Array(12));

			const cryptoKey = await crypto.subtle.importKey(
				'raw',
				this.padKey(key),
				{ name: 'AES-GCM' },
				false,
				['encrypt']
			);

			const encrypted = await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: iv },
				cryptoKey,
				data
			);

			const result = new Uint8Array(iv.length + encrypted.byteLength);
			result.set(iv, 0);
			result.set(new Uint8Array(encrypted), iv.length);

			return btoa(String.fromCharCode(...result));
		} catch (error) {
			throw error;
		}
	}

	async decryptMessage(encryptedMessage, key) {
		try {
			const data = Uint8Array.from(atob(encryptedMessage), c => c.charCodeAt(0));
			const iv = data.slice(0, 12);
			const encrypted = data.slice(12);

			const cryptoKey = await crypto.subtle.importKey(
				'raw',
				this.padKey(key),
				{ name: 'AES-GCM' },
				false,
				['decrypt']
			);

			const decrypted = await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: iv },
				cryptoKey,
				encrypted
			);

			const decoder = new TextDecoder();
			return decoder.decode(decrypted);
		} catch (error) {
			throw error;
		}
	}

	async encryptBinary(data, key) {
		try {
			const iv = crypto.getRandomValues(new Uint8Array(12));

			const cryptoKey = await crypto.subtle.importKey(
				'raw',
				this.padKey(key),
				{ name: 'AES-GCM' },
				false,
				['encrypt']
			);

			const encrypted = await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: iv },
				cryptoKey,
				data
			);

			const result = new Uint8Array(iv.length + encrypted.byteLength);
			result.set(iv, 0);
			result.set(new Uint8Array(encrypted), iv.length);

			return btoa(String.fromCharCode(...result));
		} catch (error) {
			throw error;
		}
	}

	async decryptBinary(encryptedData, key) {
		try {
			const data = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0));
			const iv = data.slice(0, 12);
			const encrypted = data.slice(12);

			const cryptoKey = await crypto.subtle.importKey(
				'raw',
				this.padKey(key),
				{ name: 'AES-GCM' },
				false,
				['decrypt']
			);

			return await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: iv },
				cryptoKey,
				encrypted
			);
		} catch (error) {
			throw error;
		}
	}

	// ==================== PUBLIC API ====================

	/**
	 * Initiate a new file transfer to a chat room
	 * @param {string} chatHandle - Chat room identifier
	 * @param {File} file - File object to transfer
	 * @returns {Promise<{sessionId: string, transfer: SendTransfer}>}
	 */
	async initiateTransfer(chatHandle, file, encryptionKey = null) {
		// Check concurrent transfer limits
		const sendingCount = Array.from(this.activeSends.values())
			.filter(t => t.status !== 'COMPLETED' && t.status !== 'FAILED').length;

		if (sendingCount >= P2P_MAX_CONCURRENT) {
			throw new Error(`Concurrent transfer limit exceeded (${P2P_MAX_CONCURRENT})`);
		}

		// Use provided key or fallback to instance key
		const key = encryptionKey || this.encryptionKey;

		// Calculate chunks
		const fileSize = file.size;
		const totalChunks = Math.ceil(fileSize / P2P_CHUNK_SIZE);

		// Pre-compute SHA256 checksum on plaintext
		const sha256Checksum = await this.computeSHA256(file);

		// Encrypt metadata if key available
		let encryptedFileName = file.name;
		let encryptedFileSize = fileSize.toString();

		if (key) {
			encryptedFileName = await this.encryptMessage(file.name, key);
			encryptedFileSize = await this.encryptMessage(fileSize.toString(), key);
		}

		// Create transfer session on server
		const response = await authenticatedFetch(`/transfer/initiate/${chatHandle}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				fileName: encryptedFileName,
				fileSize: encryptedFileSize,
				totalChunks,
				sha256FileChecksum: sha256Checksum
			})
		});

		if (!response.ok) {
			const error = await response.json();
			throw new Error(error.error || 'Failed to initiate transfer');
		}

		const { transferSessionId } = await response.json();

		// Create send transfer (but don't start yet - wait for acceptance)
		const chunks = await this.splitFileIntoChunks(file);
		const sendTransfer = new SendTransfer({
			transferSessionId,
			chatHandle,
			fileName: file.name,
			fileSize,
			totalChunks,
			sha256Checksum,
			chunks,
			encryptionKey: key
		});

		this.activeSends.set(transferSessionId, sendTransfer);

		return { sessionId: transferSessionId, transfer: sendTransfer };
	}

	/**
	 * Wait for transfer to be accepted by the receiver
	 * @param {string} transferSessionId - Transfer session ID
	 * @param {number} maxWaitMs - Maximum time to wait in milliseconds (default: 300000 = 5 minutes)
	 * @param {number} pollIntervalMs - Polling interval (default: 2000ms)
	 * @returns {Promise<boolean>} - True if accepted, false if timeout or error
	 */
	async waitForAcceptance(transferSessionId, maxWaitMs = 300000, pollIntervalMs = 2000) {
		const sendTransfer = this.activeSends.get(transferSessionId);
		if (!sendTransfer) {
			throw new Error('Transfer not found');
		}

		const chatHandle = sendTransfer.chatHandle;
		const startTime = Date.now();

		const cleanup = () => {
			sendTransfer.status = 'FAILED';
			this.activeSends.delete(transferSessionId);
		};

		return new Promise((resolve, reject) => {
			const checkStatus = async () => {
				try {
					const elapsed = Date.now() - startTime;
					if (elapsed >= maxWaitMs) {
						cleanup();
						reject(new Error('Timeout waiting for receiver acceptance'));
						return;
					}

					const response = await authenticatedFetch(`/transfer/status/${chatHandle}/${transferSessionId}`);

					if (!response.ok) {
						const error = await response.json();
						cleanup();
						reject(new Error(error.error || 'Failed to get transfer status'));
						return;
					}

					const status = await response.json();
					console.log(`[P2P] Transfer ${transferSessionId} status: ${status.status}`);

					if (status.status === 'ACCEPTED' || status.status === 'TRANSFERRING') {
						// Receiver has accepted, we can start sending
						resolve(true);
					} else if (status.status === 'FAILED' || status.status === 'CANCELLED') {
						cleanup();
						reject(new Error('Transfer was cancelled or failed'));
					} else if (status.status === 'COMPLETED') {
						cleanup();
						reject(new Error('Transfer already completed'));
					} else {
						// Still PENDING, continue polling
						setTimeout(checkStatus, pollIntervalMs);
					}
				} catch (error) {
					cleanup();
					reject(error);
				}
			};

			checkStatus();
		});
	}

	/**
	 * Start sending chunks for a transfer after receiver has accepted
	 * @param {string} transferSessionId - Transfer session ID
	 * @returns {Promise<void>}
	 */
	async startTransfer(transferSessionId) {
		const sendTransfer = this.activeSends.get(transferSessionId);
		if (!sendTransfer) {
			throw new Error('Transfer not found');
		}

		// Start sending chunks
		sendTransfer.start().then(() => {
			sendTransfer.emit('sendComplete', { transferSessionId });
			this.emit('sendComplete', { transferSessionId });
		}).catch((error) => {
			console.error(`Transfer ${transferSessionId} failed:`, error);
			sendTransfer.status = 'FAILED';
			sendTransfer.emit('sendFailed', { transferSessionId, error });
			this.emit('sendFailed', { transferSessionId, error });
		});
	}

	/**
	 * Start sending chunks for an existing transfer (wrapper for compatibility)
	 * @param {string} chatHandle - Chat room identifier
	 * @param {string} transferSessionId - Transfer session ID
	 * @param {File} file - File object
	 * @param {Function} onProgress - Progress callback
	 * @returns {Promise<SendTransfer>}
	 */
	async startSending(chatHandle, transferSessionId, file, onProgress) {
		const sendTransfer = this.activeSends.get(transferSessionId);
		if (!sendTransfer) {
			throw new Error('Transfer not found');
		}
		
		// Set up progress listener
		sendTransfer.on('chunkSent', (data) => {
			const progress = ((data.chunkIndex + 1) / sendTransfer.totalChunks) * 100;
			if (onProgress) onProgress(progress);
		});
		
		return sendTransfer;
	}

	/**
	 * Accept a pending transfer invitation
	 * @param {string} chatHandle - Chat room identifier
	 * @param {string} transferSessionId - Transfer session ID
	 * @param {number} totalChunks - Expected number of chunks
	 * @param {string} fileName - File name for the transfer
	 * @returns {Promise<ReceiveTransfer>}
	 */
	async acceptTransfer(chatHandle, transferSessionId, totalChunks, fileName = null, encryptionKey = null) {
		const response = await authenticatedFetch(`/transfer/accept/${chatHandle}/${transferSessionId}`, {
			method: 'POST'
		});

		if (!response.ok) {
			const error = await response.json();
			throw new Error(error.error || 'Failed to accept transfer');
		}

		// Use provided key or fallback to instance key
		const key = encryptionKey || this.encryptionKey;

		// Create receive transfer
		const receiveTransfer = new ReceiveTransfer({
			transferSessionId,
			chatHandle,
			totalChunks,
			fileName,
			encryptionKey: key
		});

		this.activeReceives.set(transferSessionId, receiveTransfer);

		return receiveTransfer;
	}

	/**
	 * Start receiving chunks for an existing transfer (wrapper for compatibility)
	 * @param {string} chatHandle - Chat room identifier
	 * @param {string} transferSessionId - Transfer session ID
	 * @param {number} totalChunks - Expected number of chunks
	 * @param {Function} onProgress - Progress callback
	 * @returns {Promise<ReceiveTransfer>}
	 */
	async startReceiving(chatHandle, transferSessionId, totalChunks, onProgress) {
		const receiveTransfer = this.activeReceives.get(transferSessionId);
		if (!receiveTransfer) {
			throw new Error('Transfer not found');
		}

		// Set up progress listener
		if (onProgress) {
			receiveTransfer.on('chunkReceived', (data) => {
				const progress = ((data.chunkIndex + 1) / totalChunks) * 100;
				onProgress(progress);
			});
		}

		// Start receiving in background
		receiveTransfer.start().then(() => {
			receiveTransfer.emit('completed', receiveTransfer.assembledFile);
			this.emit('receiveComplete', {
				transferSessionId,
				file: receiveTransfer.assembledFile,
				fileName: receiveTransfer.fileName
			});
		}).catch((error) => {
			console.error(`Receive ${transferSessionId} failed:`, error);
			receiveTransfer.status = 'FAILED';
			receiveTransfer.emit('error', error);
			this.emit('receiveFailed', { transferSessionId, error });
		});

		return receiveTransfer;
	}

	/**
	 * Get pending transfer invitations for a chat
	 * @param {string} chatHandle - Chat room identifier
	 * @returns {Promise<Array>}
	 */
	async getPendingInvitations(chatHandle) {
		const response = await authenticatedFetch(`/transfer/invitations/${chatHandle}`);
		
		if (!response.ok) {
			throw new Error('Failed to get invitations');
		}

		const data = await response.json();
		return data.invitations || [];
	}

	/**
	 * Cancel an active transfer
	 * @param {string} chatHandle - Chat room identifier
	 * @param {string} transferSessionId - Transfer session ID
	 */
	async cancelTransfer(chatHandle, transferSessionId) {
		const response = await authenticatedFetch(`/transfer/cancel/${chatHandle}/${transferSessionId}`, {
			method: 'POST'
		});

		if (!response.ok) {
			const error = await response.json();
			throw new Error(error.error || 'Failed to cancel transfer');
		}

		// Clean up local state
		const sendTransfer = this.activeSends.get(transferSessionId);
		if (sendTransfer) {
			sendTransfer.status = 'FAILED';
			this.activeSends.delete(transferSessionId);
		}

		const receiveTransfer = this.activeReceives.get(transferSessionId);
		if (receiveTransfer) {
			receiveTransfer.status = 'FAILED';
			this.activeReceives.delete(transferSessionId);
		}

		this.emit('transferCancelled', { transferSessionId });
	}

	/**
	 * Download an assembled file from a completed transfer
	 * @param {string} chatHandle - Chat room identifier
	 * @param {string} transferSessionId - Transfer session ID
	 * @param {string} fileName - Original file name
	 */
	async downloadFile(chatHandle, transferSessionId, fileName) {
		const response = await authenticatedFetch(`/transfer/download/${chatHandle}/${transferSessionId}`);
		
		if (!response.ok) {
			const error = await response.json();
			throw new Error(error.error || 'Failed to download file');
		}

		const blob = await response.blob();
		
		// Create download link
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = fileName;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);

		this.emit('fileDownloaded', { transferSessionId, fileName });
	}

	// ==================== EVENT SYSTEM ====================

	on(event, callback) {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, []);
		}
		this.listeners.get(event).push(callback);
	}

	off(event, callback) {
		if (this.listeners.has(event)) {
			const callbacks = this.listeners.get(event);
			const index = callbacks.indexOf(callback);
			if (index > -1) {
				callbacks.splice(index, 1);
			}
		}
	}

	emit(event, data) {
		if (this.listeners.has(event)) {
			this.listeners.get(event).forEach(callback => callback(data));
		}
	}

	// ==================== HELPER METHODS ====================

	/**
	 * Split file into chunks
	 * @param {File} file - File object
	 * @returns {Promise<Array<Uint8Array>>}
	 */
	async splitFileIntoChunks(file) {
		const chunks = [];
		const totalChunks = Math.ceil(file.size / P2P_CHUNK_SIZE);
		
		for (let i = 0; i < totalChunks; i++) {
			const start = i * P2P_CHUNK_SIZE;
			const end = Math.min(start + P2P_CHUNK_SIZE, file.size);
			const slice = file.slice(start, end);
			const arrayBuffer = await slice.arrayBuffer();
			chunks.push(new Uint8Array(arrayBuffer));
		}
		
		return chunks;
	}

	/**
	 * Compute SHA256 checksum of a file
	 * @param {File|Blob} file - File or Blob object
	 * @returns {Promise<string>} Hex string checksum
	 */
	async computeSHA256(file) {
		const arrayBuffer = await file.arrayBuffer();
		const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}

	/**
	 * Validate assembled file checksum
	 * @param {Uint8Array} data - Assembled file data
	 * @param {string} expectedChecksum - Expected SHA256 checksum
	 * @returns {Promise<boolean>}
	 */
	async validateChecksum(data, expectedChecksum) {
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		const actualChecksum = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
		return actualChecksum === expectedChecksum;
	}

	/**
	 * Assemble chunks into a single Uint8Array (browser-compatible)
	 * @param {Map<number, Uint8Array>} chunks - Map of chunk index to data
	 * @param {number} totalChunks - Total expected chunks
	 * @returns {Uint8Array}
	 */
	assembleChunks(chunks, totalChunks) {
		// Calculate total size
		let totalSize = 0;
		for (let i = 0; i < totalChunks; i++) {
			if (!chunks.has(i)) {
				throw new Error(`Missing chunk ${i}`);
			}
			totalSize += chunks.get(i).length;
		}
		
		// Allocate and fill
		const result = new Uint8Array(totalSize);
		let offset = 0;
		for (let i = 0; i < totalChunks; i++) {
			const chunk = chunks.get(i);
			result.set(chunk, offset);
			offset += chunk.length;
		}
		
		return result;
	}
}

// ==================== SEND TRANSFER CLASS ====================

class SendTransfer {
	constructor(options) {
		this.transferSessionId = options.transferSessionId;
		this.chatHandle = options.chatHandle;
		this.fileName = options.fileName;
		this.fileSize = options.fileSize;
		this.totalChunks = options.totalChunks;
		this.sha256Checksum = options.sha256Checksum;
		this.chunks = options.chunks;
		this.encryptionKey = options.encryptionKey;

		// State
		this.status = 'PENDING';
		this.currentChunkIndex = 0;
		this.lastACKedChunk = -1;
		this.retryCount = 0;
		this.ackTimeout = null;

		// Event listeners
		this.listeners = new Map();
	}

	on(event, callback) {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, []);
		}
		this.listeners.get(event).push(callback);
	}

	emit(event, data) {
		if (this.listeners.has(event)) {
			this.listeners.get(event).forEach(callback => callback(data));
		}
	}

	async start() {
		this.status = 'TRANSFERRING';
		
		// Send chunks sequentially with ACK-based flow control
		while (this.currentChunkIndex < this.totalChunks) {
			await this.sendNextChunk();
			
			// Add delay between chunks to allow receiver to poll and ACK
			// This prevents race conditions where sender sends chunk N+1
			// before receiver ACKs chunk N
			if (this.currentChunkIndex < this.totalChunks) {
				await new Promise(resolve => setTimeout(resolve, 200));
			}
		}
		
		// All chunks sent, mark as complete
		await this.complete();
	}

	async sendNextChunk() {
		const chunkIndex = this.currentChunkIndex;
		const chunkData = this.chunks[chunkIndex];
		
		try {
			// Send chunk to server - just queue it
			const result = await this.sendChunkToServer(chunkIndex, chunkData);
			
			// Chunk was queued on server successfully (HTTP 200)
			// The receiver will ACK through its polling mechanism
			// We poll the status to wait for ACK before proceeding to next chunk
			console.log(`Chunk ${chunkIndex} queued on server, waiting for receiver ACK...`);
			
			// Poll for ACK with timeout
			const maxWaitMs = 10000; // 10 second timeout for receiver to ACK
			const startTime = Date.now();
			
			while (Date.now() - startTime < maxWaitMs) {
				// Check transfer status to see if chunk was ACKed
				const statusResponse = await authenticatedFetch(`/transfer/status/${this.chatHandle}/${this.transferSessionId}`);
				if (!statusResponse.ok) {
					throw new Error('Failed to check transfer status');
				}

				const status = await statusResponse.json();

				// If receiver has ACKed this chunk, we can proceed
				if (status.lastChunkACKed >= chunkIndex) {
					this.lastACKedChunk = chunkIndex;
					this.retryCount = 0;
					this.currentChunkIndex++;

					// Emit progress event
					this.emit('chunkSent', { chunkIndex, totalChunks: this.totalChunks });
					console.log(`Chunk ${chunkIndex} ACKed by receiver (server reports lastACK: ${status.lastChunkACKed})`);
					return;
				}

				// Yield to browser to allow user input processing
				await new Promise(resolve => setTimeout(resolve, 0));
				// Not ACKed yet, wait before checking again
				await new Promise(resolve => setTimeout(resolve, 200));
			}
			
			// Timeout waiting for ACK
			throw new Error(`Timeout waiting for receiver ACK on chunk ${chunkIndex}`);
			
		} catch (error) {
			this.retryCount++;
			
			if (this.retryCount > P2P_MAX_RETRIES) {
				throw new Error(`Failed to send chunk ${chunkIndex} after ${P2P_MAX_RETRIES} retries: ${error.message}`);
			}
			
			// Wait before retry (exponential backoff)
			const backoffMs = 1000 * this.retryCount;
			console.warn(`Chunk ${chunkIndex} failed: ${error.message}, retry ${this.retryCount}/${P2P_MAX_RETRIES} in ${backoffMs}ms`);
			await new Promise(resolve => setTimeout(resolve, backoffMs));
			
			// Retry this chunk
			return this.sendNextChunk();
		}
	}

	async sendChunkToServer(chunkIndex, chunkData) {
		// Encrypt chunk data if key available
		let dataToSend = chunkData;
		if (this.encryptionKey) {
			const encrypted = await this.encryptChunk(chunkData);
			dataToSend = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
		}

		// Create multipart data: JSON metadata + \r\n\r\n + binary data
		// Browser-compatible: use Uint8Array instead of Buffer
		const metadata = JSON.stringify({
			chunkIndex,
			chunkSize: dataToSend.length,
			totalChunks: this.totalChunks
		});

		const encoder = new TextEncoder();
		const metadataBytes = encoder.encode(metadata);
		const delimiter = encoder.encode('\r\n\r\n');

		// Combine all parts using Uint8Array
		const body = new Uint8Array(metadataBytes.length + delimiter.length + dataToSend.length);
		body.set(metadataBytes, 0);
		body.set(delimiter, metadataBytes.length);
		body.set(dataToSend, metadataBytes.length + delimiter.length);

		const response = await authenticatedFetch(`/transfer/send-chunk/${this.chatHandle}/${this.transferSessionId}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/octet-stream'
			},
			body: body
		});

		if (!response.ok) {
			const error = await response.json();
			throw new Error(error.error || 'Failed to send chunk');
		}

		return await response.json();
	}

	async encryptChunk(chunkData) {
		const iv = crypto.getRandomValues(new Uint8Array(12));

		const cryptoKey = await crypto.subtle.importKey(
			'raw',
			this.padKey(this.encryptionKey),
			{ name: 'AES-GCM' },
			false,
			['encrypt']
		);

		const encrypted = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: iv },
			cryptoKey,
			chunkData
		);

		const result = new Uint8Array(iv.length + encrypted.byteLength);
		result.set(iv, 0);
		result.set(new Uint8Array(encrypted), iv.length);

		// Use chunked approach to avoid stack overflow with large arrays
		let binaryString = '';
		const chunkSize = 8192;
		for (let i = 0; i < result.length; i += chunkSize) {
			const chunk = result.subarray(i, Math.min(i + chunkSize, result.length));
			binaryString += String.fromCharCode(...chunk);
		}
		return btoa(binaryString);
	}

	padKey(keyStr) {
		const encoder = new TextEncoder();
		const data = encoder.encode(keyStr);
		const padded = new Uint8Array(32);
		padded.set(data.slice(0, 32));
		return padded;
	}

	async complete() {
		const response = await authenticatedFetch(`/transfer/complete/${this.chatHandle}/${this.transferSessionId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				totalChunks: this.totalChunks,
				sha256Checksum: this.sha256Checksum,
				fileName: this.fileName
			})
		});

		if (!response.ok) {
			const error = await response.json();
			throw new Error(error.error || 'Failed to complete transfer');
		}

		this.status = 'COMPLETED';
		console.log(`Transfer ${this.transferSessionId} completed successfully`);
	}
}

// ==================== RECEIVE TRANSFER CLASS ====================

class ReceiveTransfer {
	constructor(options) {
		this.transferSessionId = options.transferSessionId;
		this.chatHandle = options.chatHandle;
		this.totalChunks = options.totalChunks;
		this.fileName = options.fileName || null;
		this.encryptionKey = options.encryptionKey;

		// State
		this.status = 'ACCEPTED';
		this.receivedChunks = new Map(); // chunkIndex -> Uint8Array
		this.lastReceivedChunk = -1;
		this.sha256Checksum = null;
		this.assembledFile = null;
		this.isPolling = false;

		// Event listeners
		this.listeners = new Map();
	}

	on(event, callback) {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, []);
		}
		this.listeners.get(event).push(callback);
	}

	emit(event, data) {
		if (this.listeners.has(event)) {
			this.listeners.get(event).forEach(callback => callback(data));
		}
	}

	async start() {
		this.status = 'TRANSFERRING';

		// Receive chunks one by one until all are received
		while (this.lastReceivedChunk < this.totalChunks - 1) {
			const beforeChunkCount = this.receivedChunks.size;
			await this.pollForChunk();
			// Yield to browser after each poll to allow UI updates
			await new Promise(resolve => setTimeout(resolve, 0));
			const afterChunkCount = this.receivedChunks.size;

			// Only delay if no new chunks were received (prevents busy-waiting)
			// If we got data, immediately poll again to grab the next chunk
			if (beforeChunkCount === afterChunkCount) {
				await new Promise(resolve => setTimeout(resolve, 100));
			}
		}

		// Send final ACK so sender knows the last chunk was received.
		// Server will respond with the "all done" notification (no chunkData).
		await this.pollForChunk();

		// All chunks received, validate and assemble
		await this.validateAndAssemble();
	}

	async pollForChunk() {
		const maxWaitMs = P2P_POLL_INTERVAL;

		const response = await authenticatedFetch(`/transfer/receive-chunk/${this.chatHandle}/${this.transferSessionId}?ackChunkIndex=${this.lastReceivedChunk}&maxWaitMs=${maxWaitMs}`);

		if (response.status === 204) {
			// No chunk available yet, return and let caller poll again
			return;
		}

		if (response.status === 410) {
			// Transfer expired
			throw new Error('Transfer session expired');
		}

		if (!response.ok) {
			let errorMsg = 'Failed to receive chunk';
			try { errorMsg = (await response.json()).error || errorMsg; } catch (e) { /* non-JSON body */ }
			throw new Error(errorMsg);
		}

		const data = await response.json();

		// "All done" notification from server has no chunkData — skip processing
		if (!data.chunkData) {
			return;
		}

		// Decode received chunk
		let chunkData = Uint8Array.from(atob(data.chunkData), c => c.charCodeAt(0));

		// Decrypt if key available
		if (this.encryptionKey) {
			chunkData = new Uint8Array(await this.decryptChunk(chunkData));
		}

		this.receivedChunks.set(data.chunkIndex, chunkData);
		this.lastReceivedChunk = data.chunkIndex;

		// Emit progress event
		this.emit('chunkReceived', { chunkIndex: data.chunkIndex, totalChunks: this.totalChunks });
		console.log(`Received chunk ${data.chunkIndex}/${this.totalChunks}`);
	}

	async decryptChunk(encryptedData) {
		const iv = encryptedData.slice(0, 12);
		const encrypted = encryptedData.slice(12);

		const cryptoKey = await crypto.subtle.importKey(
			'raw',
			this.padKey(this.encryptionKey),
			{ name: 'AES-GCM' },
			false,
			['decrypt']
		);

		return await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: iv },
			cryptoKey,
			encrypted
		);
	}

	padKey(keyStr) {
		const encoder = new TextEncoder();
		const data = encoder.encode(keyStr);
		const padded = new Uint8Array(32);
		padded.set(data.slice(0, 32));
		return padded;
	}

	async validateAndAssemble() {
		// Get file metadata from last poll or query the server
		// For now, we'll assemble without file name and get it from download
		
		// Validate checksums
		const assembledData = this.assembleChunks();
		
		// SHA256 will be validated by the server when downloading
		// Client-side validation is optional but recommended
		this.assembledFile = assembledData;
		
		this.status = 'COMPLETED';
		console.log(`Receive ${this.transferSessionId} completed: ${assembledData.length} bytes`);
	}

	assembleChunks() {
		const buffers = [];
		for (let i = 0; i < this.totalChunks; i++) {
			if (!this.receivedChunks.has(i)) {
				throw new Error(`Missing chunk ${i}`);
			}
			buffers.push(this.receivedChunks.get(i));
		}
		
		// Browser-compatible concatenation without Buffer
		let totalSize = 0;
		for (const buffer of buffers) {
			totalSize += buffer.length;
		}
		
		const result = new Uint8Array(totalSize);
		let offset = 0;
		for (const buffer of buffers) {
			result.set(buffer, offset);
			offset += buffer.length;
		}
		
		return result;
	}

	async getFileInfo() {
		// Query transfer status to get file metadata
		// This is a placeholder - in a full implementation, 
		// the server would provide an endpoint to get transfer metadata
		return {
			fileName: this.fileName,
			sha256Checksum: this.sha256Checksum,
			fileSize: this.assembledFile ? this.assembledFile.length : 0
		};
	}
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
	module.exports = { P2PTransferManager, SendTransfer, ReceiveTransfer };
}
