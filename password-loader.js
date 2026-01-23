// password-loader.js - Load password from external .passwd file
const fs = require('fs');
const path = require('path');

let cachedPassword = null;

/**
 * Load password from .passwd file
 * @returns {string|null} The password or null if not found
 */
function loadPassword() {
  // Return cached password if available
  if (cachedPassword !== null) {
    return cachedPassword;
  }
  
  const passwdPath = path.join(__dirname, '.passwd');
  
  try {
    if (fs.existsSync(passwdPath)) {
      const password = fs.readFileSync(passwdPath, 'utf8').trim();
      
      if (password.length === 0) {
        console.error('[PasswordLoader] Error: .passwd file is empty');
        return null;
      }
      
      cachedPassword = password;
      console.log('[PasswordLoader] Password loaded successfully');
      return password;
    } else {
      console.error('[PasswordLoader] Error: .passwd file not found');
      return null;
    }
  } catch (error) {
    console.error('[PasswordLoader] Error reading .passwd file:', error.message);
    return null;
  }
}

/**
 * Reload password from file (useful for hot-reloading)
 * @returns {string|null} The password or null if not found
 */
function reloadPassword() {
  cachedPassword = null;
  return loadPassword();
}

/**
 * Check if password file exists
 * @returns {boolean} True if password file exists
 */
function hasPasswordFile() {
  const passwdPath = path.join(__dirname, '.passwd');
  return fs.existsSync(passwdPath);
}

module.exports = {
  loadPassword,
  reloadPassword,
  hasPasswordFile
};
