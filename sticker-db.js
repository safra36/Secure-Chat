/**
 * IndexedDB Sticker Storage
 * Per-user sticker collection. Stores decrypted image data locally.
 * Max 512KB per sticker. Separate from content cache DB.
 */

class StickerDB {
    constructor() {
        this.dbName = 'SecureStickerDB';
        this.dbVersion = 1;
        this.storeName = 'stickers';
        this.db = null;
        this.isInitialized = false;
        this.MAX_STICKER_BYTES = 512 * 1024; // 512KB
    }

    async init() {
        if (this.isInitialized) return;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            request.onerror = (e) => reject(e.target.error);
            request.onsuccess = (e) => {
                this.db = e.target.result;
                this.isInitialized = true;
                resolve();
            };
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'stickerId' });
                    store.createIndex('savedAt', 'savedAt', { unique: false });
                    store.createIndex('source', 'source', { unique: false });
                }
            };
        });
    }

    /**
     * Add or update a sticker in the collection.
     * @param {string} stickerId - Unique identifier
     * @param {string} imageData - Base64-encoded raw image bytes (decrypted)
     * @param {string} contentType - MIME type e.g. 'image/png'
     * @param {string} name - Optional label
     * @param {string} source - 'own' | 'saved'
     */
    async addSticker(stickerId, imageData, contentType, name, source) {
        await this.init();
        const byteSize = Math.ceil(imageData.length * 0.75);
        if (byteSize > this.MAX_STICKER_BYTES) {
            throw new Error(`Sticker too large: ${Math.round(byteSize / 1024)}KB (max 512KB)`);
        }
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([this.storeName], 'readwrite');
            const store = tx.objectStore(this.storeName);
            const req = store.put({
                stickerId,
                imageData,
                contentType: contentType || 'image/png',
                name: name || '',
                savedAt: Date.now(),
                source: source || 'own'
            });
            req.onsuccess = () => resolve(true);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    /** Returns all stickers, newest first. */
    async getAll() {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([this.storeName], 'readonly');
            const store = tx.objectStore(this.storeName);
            const index = store.index('savedAt');
            const req = index.openCursor(null, 'prev');
            const results = [];
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) { results.push(cursor.value); cursor.continue(); }
                else resolve(results);
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async getById(stickerId) {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([this.storeName], 'readonly');
            const store = tx.objectStore(this.storeName);
            const req = store.get(stickerId);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async hasSticker(stickerId) {
        try {
            return (await this.getById(stickerId)) !== null;
        } catch (e) {
            return false;
        }
    }

    async deleteSticker(stickerId) {
        await this.init();
        return new Promise((resolve) => {
            const tx = this.db.transaction([this.storeName], 'readwrite');
            const store = tx.objectStore(this.storeName);
            const req = store.delete(stickerId);
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
        });
    }

    async count() {
        await this.init();
        return new Promise((resolve) => {
            const tx = this.db.transaction([this.storeName], 'readonly');
            const store = tx.objectStore(this.storeName);
            const req = store.count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(0);
        });
    }
}

const stickerDB = new StickerDB();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { StickerDB, stickerDB };
}
