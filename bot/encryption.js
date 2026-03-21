const crypto = require('crypto');

class Encryption {
	keys = new Map()

	getKeyPairs() {

		const randomId = crypto.randomBytes(8).toString("hex")

		const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
			namedCurve: 'secp256k1',
			publicKeyEncoding: {
				type: 'spki',
				format: 'pem',
			},
			privateKeyEncoding: {
				type: 'pkcs8',
				format: 'pem',
			},
		});

		this.keys.set(randomId, [publicKey, privateKey]);

		return randomId;
	}

	encryptWithKey(message, index) {
		const [pubKey, privateKey] = this.keys[index];
		return this.encrypt(message, pubKey);
	}

	decryptWithKey(encryptedMessage, index = this.index) {
		const [pubKey, privateKey] = this.keys[index];
		return this.decrypt(encryptedMessage, privateKey);
	}

	padKey(keyStr) {
		// Pad/truncate to 32 bytes (256 bits)
		const data = Buffer.from(keyStr, 'utf8');
		const padded = Buffer.alloc(32);
		data.copy(padded, 0, 0, Math.min(data.length, 32));
		return padded;
	}

	// AES-256-GCM Encryption for text messages
	encryptBlockMessage(message, key) {
		try {
			const iv = crypto.randomBytes(12);
			const cipher = crypto.createCipheriv('aes-256-gcm', this.padKey(key), iv);
			
			let encrypted = cipher.update(message, 'utf8', 'binary');
			encrypted += cipher.final('binary');
			
			const authTag = cipher.getAuthTag();
			
			// Combine IV + encrypted + authTag
			const result = Buffer.concat([iv, Buffer.from(encrypted, 'binary'), authTag]);
			
			// Convert to base64 for transmission
			return result.toString('base64');
		} catch (error) {
			throw error;
		}
	}

	// AES-256-GCM Decryption
	decryptBlockMessage(encryptedMessage, key) {
		try {
			// Convert from base64
			const data = Buffer.from(encryptedMessage, 'base64');
			
			// Extract IV (first 12 bytes), authTag (last 16 bytes), and encrypted data (middle)
			const iv = data.slice(0, 12);
			const authTag = data.slice(-16);
			const encrypted = data.slice(12, -16);
			
			// Create decipher with authTag
			const decipher = crypto.createDecipheriv('aes-256-gcm', this.padKey(key), iv);
			decipher.setAuthTag(authTag);
			
			let decrypted = decipher.update(encrypted, 'binary', 'utf8');
			decrypted += decipher.final('utf8');
			
			return decrypted;
		} catch (error) {
			throw error;
		}
	}
}

module.exports = Encryption;
