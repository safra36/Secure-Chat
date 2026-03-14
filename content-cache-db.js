/**
 * IndexedDB Content Cache for Secure Chat
 * Provides much larger storage capacity than localStorage (100MB-1GB+ vs 5-10MB)
 * with native binary support and better performance for encrypted media content.
 */

class ContentCacheDB {
    constructor() {
        this.dbName = 'SecureChatDB';
        this.dbVersion = 1;
        this.storeName = 'content';
        this.db = null;
        this.isInitialized = false;
    }

    /**
     * Initialize the IndexedDB database and create object store if needed
     */
    async init() {
        if (this.isInitialized) return;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = (event) => {
                console.error('Failed to open IndexedDB:', event.target.error);
                reject(event.target.error);
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                this.isInitialized = true;
                this.db.onclose = () => {
                    this.db = null;
                    this.isInitialized = false;
                };
                this.db.onversionchange = () => {
                    this.db.close();
                    this.db = null;
                    this.isInitialized = false;
                };
                console.log('✅ IndexedDB initialized successfully');
                resolve();
            };

            request.onupgradeneeded = (event) => {
                console.log('Creating IndexedDB schema...');
                const db = event.target.result;

                // Create content store with indexes for efficient queries
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'messageId' });

                    // Index for eviction based on cached timestamp (LRU)
                    store.createIndex('cachedAt', 'cachedAt', { unique: false });

                    // Index for tracking last access (for better LRU)
                    store.createIndex('lastAccessed', 'lastAccessed', { unique: false });

                    // Index for size-based quota management
                    store.createIndex('size', 'size', { unique: false });

                    // Index for per-chat clearing
                    store.createIndex('chatHandle', 'chatHandle', { unique: false });

                    console.log('✅ IndexedDB schema created with indexes');
                }
            };
        });
    }

    /**
     * Store encrypted content in IndexedDB
     * @param {string} messageId - Unique message identifier
     * @param {string} encryptedBase64 - Base64 encoded encrypted content
     * @param {string} chatHandle - Chat identifier for organization
     * @param {string} contentType - 'voice' or 'image'
     * @returns {Promise<boolean>} Success status
     */
    async setContent(messageId, encryptedBase64, chatHandle, contentType) {
        try {
            await this.init();

            const dataSize = encryptedBase64.length * 2; // UTF-16 estimate

            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);

            const data = {
                messageId: messageId,
                chatHandle: chatHandle,
                encryptedContent: encryptedBase64,
                contentType: contentType,
                size: dataSize,
                cachedAt: Date.now(),
                lastAccessed: Date.now()
            };

            const request = store.put(data);

            return new Promise((resolve, reject) => {
                request.onsuccess = () => {
                    console.log(`✅ Cached content in IndexedDB: ${messageId} (${dataSize} bytes, ${contentType})`);
                    resolve(true);
                };

                request.onerror = (event) => {
                    console.error('Failed to cache content in IndexedDB:', event.target.error);
                    reject(event.target.error);
                };
            });
        } catch (error) {
            console.error('Error caching content in IndexedDB:', error);
            return false;
        }
    }

    /**
     * Retrieve encrypted content from IndexedDB
     * @param {string} messageId - Message identifier
     * @returns {Promise<string|null>} Base64 encoded encrypted content or null
     */
    async getContent(messageId) {
        try {
            await this.init();

            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(messageId);

            return new Promise((resolve, reject) => {
                request.onsuccess = () => {
                    if (request.result) {
                        // Update last accessed timestamp
                        this.updateLastAccessed(messageId);
                        resolve(request.result.encryptedContent);
                    } else {
                        resolve(null);
                    }
                };

                request.onerror = (event) => {
                    console.error('Error retrieving content from IndexedDB:', event.target.error);
                    reject(event.target.error);
                };
            });
        } catch (error) {
            console.error('Error getting content from IndexedDB:', error);
            return null;
        }
    }

    /**
     * Delete specific content from IndexedDB
     * @param {string} messageId - Message identifier
     * @returns {Promise<boolean>} Success status
     */
    async deleteContent(messageId) {
        try {
            await this.init();

            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.delete(messageId);

            return new Promise((resolve) => {
                request.onsuccess = () => {
                    console.log(`🗑️ Deleted content from IndexedDB: ${messageId}`);
                    resolve(true);
                };

                request.onerror = () => {
                    resolve(false);
                };
            });
        } catch (error) {
            console.error('Error deleting content from IndexedDB:', error);
            return false;
        }
    }

    /**
     * Clear all cached content for a specific chat
     * @param {string} chatHandle - Chat identifier
     * @returns {Promise<number>} Number of items deleted
     */
    async clearChatContent(chatHandle) {
        try {
            await this.init();

            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('chatHandle');
            const request = index.openKeyCursor(IDBKeyRange.only(chatHandle));

            let deletedCount = 0;

            return new Promise((resolve, reject) => {
                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        store.delete(cursor.primaryKey);
                        deletedCount++;
                        cursor.continue();
                    } else {
                        console.log(`🗑️ Cleared ${deletedCount} cached items for chat: ${chatHandle}`);
                        resolve(deletedCount);
                    }
                };

                request.onerror = (event) => {
                    console.error('Error clearing chat content:', event.target.error);
                    reject(event.target.error);
                };
            });
        } catch (error) {
            console.error('Error clearing chat content from IndexedDB:', error);
            return 0;
        }
    }

    /**
     * Clear all cached content
     * @returns {Promise<number>} Number of items deleted
     */
    async clearAllContent() {
        try {
            await this.init();

            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.clear();

            return new Promise((resolve) => {
                request.onsuccess = () => {
                    const deletedCount = request.result;
                    console.log(`🗑️ Cleared all ${deletedCount} cached items from IndexedDB`);
                    resolve(deletedCount);
                };

                request.onerror = () => {
                    resolve(0);
                };
            });
        } catch (error) {
            console.error('Error clearing all content from IndexedDB:', error);
            return 0;
        }
    }

    /**
     * Evict oldest cached content to free up space (LRU strategy)
     * @param {number} targetSize - Target size to free in bytes
     * @returns {Promise<number>} Bytes freed
     */
    async evictOldest(targetSize = 1024 * 1024) {
        try {
            await this.init();

            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('cachedAt');

            const request = index.openCursor();
            let freedBytes = 0;

            return new Promise((resolve, reject) => {
                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor && freedBytes < targetSize) {
                        const data = cursor.value;
                        store.delete(cursor.primaryKey);
                        freedBytes += data.size || 0;
                        console.log(`Evicted oldest content: ${data.messageId} (${data.size} bytes)`);
                        cursor.continue();
                    } else {
                        console.log(`Freed ${freedBytes} bytes from IndexedDB`);
                        resolve(freedBytes);
                    }
                };

                request.onerror = (event) => {
                    console.error('Error during eviction:', event.target.error);
                    reject(event.target.error);
                };
            });
        } catch (error) {
            console.error('Error evicting content from IndexedDB:', error);
            return 0;
        }
    }

    /**
     * Get storage statistics
     * @returns {Promise<Object>} Storage stats
     */
    async getStats() {
        try {
            await this.init();

            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);

            return new Promise((resolve) => {
                // Get total count
                const countRequest = store.count();
                countRequest.onsuccess = () => {
                    const totalItems = countRequest.result;

                    // Get all items to calculate total size
                    const getAllRequest = store.getAll();
                    getAllRequest.onsuccess = () => {
                        const items = getAllRequest.result;
                        const totalBytes = items.reduce((sum, item) => sum + (item.size || 0), 0);

                        // Group by chat handle
                        const chatGroups = {};
                        items.forEach(item => {
                            const handle = item.chatHandle || 'unknown';
                            if (!chatGroups[handle]) {
                                chatGroups[handle] = { count: 0, bytes: 0 };
                            }
                            chatGroups[handle].count++;
                            chatGroups[handle].bytes += item.size || 0;
                        });

                        resolve({
                            totalItems,
                            totalBytes,
                            chatGroups,
                            avgItemBytes: totalItems > 0 ? Math.round(totalBytes / totalItems) : 0
                        });
                    };

                    getAllRequest.onerror = () => {
                        resolve({
                            totalItems,
                            totalBytes: 0,
                            chatGroups: {},
                            avgItemBytes: 0
                        });
                    };
                };

                countRequest.onerror = () => {
                    resolve({
                        totalItems: 0,
                        totalBytes: 0,
                        chatGroups: {},
                        avgItemBytes: 0
                    });
                };
            });
        } catch (error) {
            console.error('Error getting IndexedDB stats:', error);
            return {
                totalItems: 0,
                totalBytes: 0,
                chatGroups: {},
                avgItemBytes: 0
            };
        }
    }

    /**
     * Update last accessed timestamp for LRU tracking
     * @param {string} messageId - Message identifier
     */
    async updateLastAccessed(messageId) {
        try {
            await this.init();

            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const getRequest = store.get(messageId);

            getRequest.onsuccess = () => {
                const data = getRequest.result;
                if (data) {
                    data.lastAccessed = Date.now();
                    store.put(data);
                }
            };
        } catch (error) {
            console.warn('Failed to update last accessed timestamp:', error);
        }
    }

    /**
     * Check if content exists in cache
     * @param {string} messageId - Message identifier
     * @returns {Promise<boolean>} Exists status
     */
    async hasContent(messageId) {
        try {
            const content = await this.getContent(messageId);
            return content !== null;
        } catch (error) {
            return false;
        }
    }

    /**
     * Migrate content from localStorage to IndexedDB
     * @returns {Promise<Object>} Migration result
     */
    async migrateFromLocalStorage() {
        console.log('Starting migration from localStorage to IndexedDB...');
        
        const migrated = { success: 0, failed: 0, total: 0 };
        const CONTENT_KEY_PREFIX = 'content_';

        try {
            // Find all content keys in localStorage
            const contentKeys = [];
            for (let key in localStorage) {
                if (key.startsWith(CONTENT_KEY_PREFIX)) {
                    contentKeys.push(key);
                }
            }

            migrated.total = contentKeys.length;
            console.log(`Found ${contentKeys.length} items to migrate`);

            for (const key of contentKeys) {
                try {
                    const messageId = key.replace(CONTENT_KEY_PREFIX, '');
                    const encryptedContent = localStorage.getItem(key);

                    if (encryptedContent) {
                        // Try to determine chat handle and content type from message cache
                        let chatHandle = 'migrated';
                        let contentType = 'unknown';

                        // Try to extract info from message cache
                        for (let msgKey in localStorage) {
                            if (msgKey.startsWith('messages_')) {
                                try {
                                    const messages = JSON.parse(localStorage.getItem(msgKey));
                                    const message = messages.find(m => m.id === messageId);
                                    if (message) {
                                        chatHandle = msgKey.replace('messages_', '');
                                        contentType = message.type || 'unknown';
                                        break;
                                    }
                                } catch (e) {
                                    // Continue to next message cache
                                }
                            }
                        }

                        // Store in IndexedDB
                        await this.setContent(messageId, encryptedContent, chatHandle, contentType);
                        
                        // Remove from localStorage
                        localStorage.removeItem(key);
                        migrated.success++;
                    } else {
                        migrated.failed++;
                    }
                } catch (error) {
                    console.warn(`Failed to migrate ${key}:`, error);
                    migrated.failed++;
                }
            }

            console.log(`Migration complete: ${migrated.success}/${migrated.total} items migrated successfully`);
            return migrated;

        } catch (error) {
            console.error('Migration error:', error);
            return migrated;
        }
    }

    /**
     * Check if IndexedDB is available and working
     * @returns {Promise<boolean>} Availability status
     */
    async isAvailable() {
        try {
            await this.init();
            return this.db !== null;
        } catch (error) {
            console.warn('IndexedDB not available:', error);
            return false;
        }
    }
}

// Create global instance
const contentCacheDB = new ContentCacheDB();

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ContentCacheDB, contentCacheDB };
}