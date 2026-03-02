// Global client error reporter — posts encrypted errors to /client-error (authenticated)

async function _encryptErrorPayload(plaintext) {
	try {
		const keyStr = localStorage.getItem('serverPassword');
		if (!keyStr) return null;

		// Pad key to 32 bytes (matches server-side padKey logic)
		const rawKey = new TextEncoder().encode(keyStr);
		const padded = new Uint8Array(32);
		padded.set(rawKey.slice(0, 32));

		const cryptoKey = await crypto.subtle.importKey(
			'raw', padded, { name: 'AES-GCM' }, false, ['encrypt']
		);

		const iv = crypto.getRandomValues(new Uint8Array(12));
		const encrypted = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv },
			cryptoKey,
			new TextEncoder().encode(plaintext)
		);

		// Pack: IV (12) | ciphertext+tag
		const result = new Uint8Array(iv.length + encrypted.byteLength);
		result.set(iv, 0);
		result.set(new Uint8Array(encrypted), iv.length);
		return btoa(String.fromCharCode(...result));
	} catch (_) {
		return null;
	}
}

async function reportError(payload) {
	try {
		const json = JSON.stringify(payload);
		const encrypted = await _encryptErrorPayload(json);

		if (encrypted) {
			await authenticatedFetch('/client-error', {
				method: 'POST',
				headers: { 'Content-Type': 'text/plain' },
				body: encrypted,
			});
		}
	} catch (_) {
		// Silently ignore — reporter itself must not throw
	}
}

window.onerror = function (message, source, lineno, colno, error) {
	reportError({
		type: 'uncaught',
		message: String(message),
		source: source || '',
		lineno,
		colno,
		stack: error?.stack || null,
		url: window.location.href,
	});
	return false;
};

window.addEventListener('unhandledrejection', function (event) {
	const reason = event.reason;
	reportError({
		type: 'unhandledrejection',
		message: reason instanceof Error ? reason.message : String(reason),
		stack: reason instanceof Error ? reason.stack : null,
		url: window.location.href,
	});
});

window.reportClientError = function (error, context) {
	reportError({
		type: 'manual',
		message: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : null,
		url: window.location.href,
		context: context || null,
	});
};
