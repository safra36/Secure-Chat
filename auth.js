// Authentication utilities for the secure chat app

let _serverBuildId = null;
let _resyncingTime = null;

/**
 * Re-sync pageLoadTime/serverTime from /time-sync endpoint.
 * Requires serverPassword in localStorage to decrypt the response.
 * Returns true if sync succeeded.
 */
async function _resyncServerTime() {
	const serverPassword = localStorage.getItem('serverPassword');
	if (!serverPassword) return false;

	try {
		const clientTime = Date.now();
		const response = await fetch('/time-sync', {
			method: 'GET',
			headers: { 'Content-Type': 'application/json' }
		});
		if (!response.ok) return false;

		const data = await response.json();
		const binary = new Uint8Array(atob(data.encryptedTime).split('').map(c => c.charCodeAt(0)));
		const iv = binary.slice(0, 12);
		const encrypted = binary.slice(12);

		// padKey: zero-padded 32-byte key from password string
		const encoder = new TextEncoder();
		const keyData = encoder.encode(serverPassword);
		const padded = new Uint8Array(32);
		padded.set(keyData.slice(0, 32));

		const cryptoKey = await crypto.subtle.importKey(
			'raw', padded, { name: 'AES-GCM' }, false, ['decrypt']
		);
		const decrypted = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv, tagLength: 128 }, cryptoKey, encrypted
		);
		const serverTime = parseInt(new TextDecoder().decode(decrypted), 10);

		localStorage.setItem('pageLoadTime', clientTime.toString());
		localStorage.setItem('serverTime', serverTime.toString());
		console.log(`🔄 Auth time re-synced. Offset: ${clientTime - serverTime}ms`);
		return true;
	} catch (e) {
		console.error('Auth time re-sync failed:', e);
		return false;
	}
}

async function _verifyBuildHmac(buildId, receivedHmac, password) {
	try {
		const enc = new TextEncoder();
		const key = await crypto.subtle.importKey(
			'raw', enc.encode(password),
			{ name: 'HMAC', hash: 'SHA-256' },
			false, ['sign']
		);
		const sig = await crypto.subtle.sign('HMAC', key, enc.encode(buildId));
		const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
		return expected === receivedHmac;
	} catch {
		return false;
	}
}

/**
 * Get credentials from localStorage
 * @returns {Object|null} Object with userId and privateKey, or null if not found
 */
function getCredentials() {
	const privateKey = localStorage.getItem('privateKey');
	const userId = localStorage.getItem('userId');
	const publicKey = localStorage.getItem('publicKey');

	if (!privateKey || !userId || !publicKey) {
		return null;
	}

	return { userId, privateKey, publicKey };
}

/**
 * Calculate effective server time using page load time and stored server time
 * Formula: effectiveTime = serverTime + (Date.now() - pageLoadTime)
 * This accounts for elapsed time since page load
 *
 * @returns {number|null} Effective server time in milliseconds, or null if not available
 */
function getEffectiveServerTime() {
	const pageLoadTime = localStorage.getItem('pageLoadTime');
	const serverTime = localStorage.getItem('serverTime');

	if (!pageLoadTime || !serverTime) {
		return null;
	}

	const pageLoadMs = parseInt(pageLoadTime, 10);
	const serverTimeMs = parseInt(serverTime, 10);

	// Calculate how much time has passed since page load
	const elapsedTime = Date.now() - pageLoadMs;

	// Effective server time = server time at page load + elapsed time
	const effectiveTime = serverTimeMs + elapsedTime;

	return effectiveTime;
}

/**
 * Generate time-based authentication token
 * Format: userId:signature
 * Signature = SHA256(privateKey + timeBucket)
 * Time bucket = current time rounded down to nearest 5 seconds
 *
 * Uses server time offset from login if available, with automatic fallback to local time
 * Server time is transmitted during password validation and stored, avoiding need for extra requests
 *
 * @returns {string|null} Authorization header value, or null if no credentials
 */
async function getToken() {
	const credentials = getCredentials();
	if (!credentials) return null;

	const { userId, privateKey: privateKeyStr, publicKey } = credentials;

	let effectiveTime = getEffectiveServerTime();
	if (effectiveTime === null) effectiveTime = Date.now();

	const timeBucket = effectiveTime - (effectiveTime % 5000);

	try {
		const privateKey = await crypto.subtle.importKey(
			'jwk',
			JSON.parse(privateKeyStr),
			{ name: 'Ed25519' },
			false,
			['sign']
		);
		const signatureBuffer = await crypto.subtle.sign(
			{ name: 'Ed25519' },
			privateKey,
			new TextEncoder().encode(timeBucket.toString())
		);
		const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
		return `${userId}:${publicKey}:${signature}`;
	} catch (error) {
		console.error('Error generating token:', error);
		return null;
	}
}



/**
 * Get authorization header value asynchronously
 * @returns {Promise<string>} Authorization header value or empty string
 */
async function getAuthHeader() {
	const token = await getToken();
	return token ? token : '';
}

/**
 * Validate that credentials exist and are stored
 * Also checks if session has expired
 * @returns {boolean} True if credentials are valid and session not expired, false otherwise
 */
function validateCredentials() {
	// Check if session management functions are available
	if (typeof isSessionValid === 'function') {
		return isSessionValid();
	}

	// Fallback: just check if credentials exist
	const credentials = getCredentials();
	return credentials !== null;
}

/**
 * Clear credentials and redirect to login page
 * This is used for logout and when authentication fails
 * @param {boolean} automatic - If true, skip confirmation dialog (default: false)
 */
function logout(automatic = false) {
	if (!automatic && !confirm('Are you sure you want to logout?')) {
		return;
	}

	// Clear all credentials including session data
	if (window.clearCredentials) {
		window.clearCredentials();
	} else {
		// Fallback if clearCredentials is not available (identity keys are permanent)
		localStorage.removeItem('serverPassword');
		localStorage.removeItem('sessionLoginTime');
		localStorage.removeItem('sessionDuration');
		localStorage.removeItem('sessionRememberMe');
		localStorage.removeItem('pageLoadTime');
		localStorage.removeItem('serverTime');
	}

	// Clear session expiry checker
	if (window.sessionExpiryInterval) {
		clearInterval(window.sessionExpiryInterval);
		window.sessionExpiryInterval = null;
	}

	window.location.href = '/';
}

/**
 * Create a fetch wrapper that includes authorization header
 * Automatically handles 401 unauthorized responses by redirecting to login
 *
 * @param {string} url - The URL to fetch
 * @param {object} options - Fetch options (method, headers, body, etc.)
 * @returns {Promise<Response>} Fetch response
 */
async function authenticatedFetch(url, options = {}) {
	const authHeader = await getAuthHeader();

	// Add authorization header to existing headers
	const headers = options.headers || {};
	headers['Authorization'] = authHeader;

	options.headers = headers;

	try {
		const response = await fetch(url, options);

		// Detect server restart/update — HMAC-verified to prevent forged reloads
		const buildHeader = response.headers.get('X-Server-Build');
		if (buildHeader) {
			const dotIdx = buildHeader.lastIndexOf('.');
			if (dotIdx !== -1) {
				const buildId = buildHeader.slice(0, dotIdx);
				const receivedHmac = buildHeader.slice(dotIdx + 1);
				const serverPassword = localStorage.getItem('serverPassword');
				if (serverPassword && await _verifyBuildHmac(buildId, receivedHmac, serverPassword)) {
					if (_serverBuildId === null) {
						_serverBuildId = buildId;
					} else if (_serverBuildId !== buildId) {
						console.log('Server updated — clearing cache and reloading client.');
						if ('caches' in window) {
							const keys = await caches.keys();
							await Promise.all(keys.map(k => caches.delete(k)));
						}
						location.reload();
					}
				}
			}
		}

		// On 401, attempt time re-sync and retry once
		if (response.status === 401) {
			// Deduplicate concurrent re-syncs
			if (!_resyncingTime) {
				_resyncingTime = _resyncServerTime().finally(() => { _resyncingTime = null; });
			}
			const synced = await _resyncingTime;
			if (synced) {
				const retryHeader = await getAuthHeader();
				options.headers['Authorization'] = retryHeader;
				return fetch(url, options);
			}
		}

		return response;
	} catch (error) {
		console.error('Fetch error:', error);
		throw error;
	}
}

// Export functions for use in other files
if (typeof module !== 'undefined' && module.exports) {
	// Node.js environment
	module.exports = {
		getCredentials,
		getToken,
		getAuthHeader,
		validateCredentials,
		logout,
		authenticatedFetch
	};
}

