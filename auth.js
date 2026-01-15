// Authentication utilities for the secure chat app

/**
 * Get credentials from localStorage
 * @returns {Object|null} Object with userId and privateKey, or null if not found
 */
function getCredentials() {
	const privateKey = localStorage.getItem('privateKey');
	const userId = localStorage.getItem('userId');

	if (!privateKey || !userId) {
		return null;
	}

	return {
		userId: userId,
		privateKey: privateKey
	};
}

/**
 * Generate time-based authentication token
 * Format: userId:signature
 * Signature = SHA256(privateKey + timeBucket)
 * Time bucket = current time rounded down to nearest 5 seconds
 * 
 * @returns {string|null} Authorization header value, or null if no credentials
 */
function getToken() {
	const credentials = getCredentials();
	if (!credentials) {
		return null;
	}

	const { userId, privateKey } = credentials;

	// Calculate 5-second time bucket
	const timeBucket = Date.now() - (Date.now() % 5000);

	// Generate SHA-256 hash of privateKey:timeBucket
	const message = `${privateKey}:${timeBucket}`;
	
	return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(message))
		.then(hashBuffer => {
			// Convert buffer to hex string
			const hashArray = Array.from(new Uint8Array(hashBuffer));
			const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
			
			return `${userId}:${hashHex}`;
		})
		.catch(error => {
			console.error('Error generating token:', error);
			return null;
		});
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
 * @returns {boolean} True if credentials are valid, false otherwise
 */
function validateCredentials() {
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
	
	localStorage.removeItem('privateKey');
	localStorage.removeItem('userId');
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
		
		// If unauthorized, clear credentials and redirect to login
		if (response.status === 401) {
			console.warn('Authentication failed, redirecting to login...');
			logout(true); // Pass true to skip confirmation dialog
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