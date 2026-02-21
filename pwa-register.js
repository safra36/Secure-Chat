// PWA Registration and Update Handler
// Register service worker and handle updates

export function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then((registration) => {
          console.log('[PWA] ServiceWorker registration successful:', registration.scope);
          
          // Check for updates periodically
          setInterval(() => {
            registration.update();
          }, 60 * 60 * 1000); // Check every hour
          
          // Handle updates
          registration.addEventListener('updatefound', () => {
            const newWorker = registration.installing;
            console.log('[PWA] New service worker found');
            
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // New service worker available, prompt user to update
                showUpdateNotification();
              }
            });
          });
        })
        .catch((err) => {
          console.error('[PWA] ServiceWorker registration failed:', err);
        });
    });
  }
}

// Show notification when update is available
function showUpdateNotification() {
  // Create update prompt
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #4fc3f7;
    color: #000;
    padding: 16px 24px;
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    z-index: 10000;
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 14px;
    font-weight: 500;
    animation: slideUp 0.3s ease;
  `;
  
  notification.innerHTML = `
    <span>🔄 New version available!</span>
    <button id="update-btn" style="
      background: #000;
      color: #4fc3f7;
      border: none;
      padding: 8px 16px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
    ">Update</button>
    <button id="dismiss-btn" style="
      background: transparent;
      color: #000;
      border: none;
      padding: 8px;
      cursor: pointer;
      font-size: 18px;
      opacity: 0.7;
    ">&times;</button>
  `;
  
  document.body.appendChild(notification);
  
  // Add animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideUp {
      from { opacity: 0; transform: translateX(-50%) translateY(20px); }
      to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
  `;
  document.head.appendChild(style);
  
  // Handle update button
  document.getElementById('update-btn').addEventListener('click', () => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then((registration) => {
        if (registration && registration.waiting) {
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
        window.location.reload();
      });
    }
  });
  
  // Handle dismiss button
  document.getElementById('dismiss-btn').addEventListener('click', () => {
    notification.style.animation = 'slideDown 0.3s ease reverse';
    setTimeout(() => notification.remove(), 300);
  });
  
  // Auto-dismiss after 10 seconds
  setTimeout(() => {
    if (notification.parentNode) {
      notification.style.animation = 'slideDown 0.3s ease reverse';
      setTimeout(() => notification.remove(), 300);
    }
  }, 10000);
}

// Check if app is installed/running as standalone
export function isAppInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.navigator.standalone === true;
}

// Prompt for install (if supported)
export async function promptInstall() {
  let deferredPrompt;
  
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    console.log('[PWA] Install prompt available');
  });
  
  return {
    canInstall: () => !!deferredPrompt,
    prompt: async () => {
      if (!deferredPrompt) {
        console.log('[PWA] Install prompt not available');
        return false;
      }
      
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      console.log('[PWA] Install prompt outcome:', outcome);
      deferredPrompt = null;
      return outcome === 'accepted';
    }
  };
}

// Initialize PWA features
registerServiceWorker();
