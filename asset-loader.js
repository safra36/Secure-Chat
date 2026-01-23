// asset-loader.js - Embeds static files into the binary
const fs = require('fs');
const path = require('path');

// Store embedded assets in memory
const embeddedAssets = new Map();

// List of files to embed
const filesToEmbed = [
  'index.html',
  'login.html',
  'auth.js',
  'encryption.js',
  'pako.min.js'
];

/**
 * Load all static assets during initialization
 * This function is called when the module is first loaded
 */
function loadAssets() {
  console.log('[AssetLoader] Loading embedded assets...');
  
  filesToEmbed.forEach(file => {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
      const assetData = fs.readFileSync(filePath);
      embeddedAssets.set(file, assetData);
      console.log(`[AssetLoader] Embedded: ${file} (${assetData.length} bytes)`);
    } else {
      console.warn(`[AssetLoader] Warning: File not found: ${file}`);
    }
  });
  
  // Ensure assets directory exists for certificates
  const assetDir = path.join(__dirname, 'assets');
  if (!fs.existsSync(assetDir)) {
    fs.mkdirSync(assetDir, { recursive: true });
  }
  
  // Copy certificates to assets directory
  const certDir = path.join(__dirname, 'cert');
  const assetsCertDir = path.join(assetDir, 'cert');
  
  if (fs.existsSync(certDir)) {
    copyDirectory(certDir, assetsCertDir);
  } else {
    console.warn('[AssetLoader] Warning: cert directory not found');
  }
  
  console.log(`[AssetLoader] Total embedded assets: ${embeddedAssets.size}`);
}

/**
 * Helper function to copy directories recursively
 */
function copyDirectory(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  entries.forEach(entry => {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      console.log(`[AssetLoader] Copied certificate: ${entry.name}`);
    }
  });
}

/**
 * Get embedded asset by filename
 * @param {string} fileName - The filename to retrieve
 * @returns {Buffer|null} The asset data or null if not found
 */
function getAsset(fileName) {
  return embeddedAssets.get(fileName) || null;
}

/**
 * Check if asset exists
 * @param {string} fileName - The filename to check
 * @returns {boolean} True if asset exists
 */
function hasAsset(fileName) {
  return embeddedAssets.has(fileName);
}

/**
 * Get list of all embedded asset filenames
 * @returns {string[]} Array of asset filenames
 */
function getAssetList() {
  return Array.from(embeddedAssets.keys());
}

/**
 * Get total size of all embedded assets
 * @returns {number} Total size in bytes
 */
function getTotalAssetSize() {
  let total = 0;
  for (const data of embeddedAssets.values()) {
    total += data.length;
  }
  return total;
}

// Initialize on load
loadAssets();

module.exports = {
  getAsset,
  hasAsset,
  getAssetList,
  getTotalAssetSize,
  loadAssets
};
