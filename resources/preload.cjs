/**
 * Desktop-shell bridge exposed to the packaged web renderer. The web app is
 * also a plain browser target, so every capability is optional: the bridge
 * exists only inside the Electron shell, and callers use optional chaining.
 * Sandboxed preload — only electron's contextBridge and ipcRenderer are
 * available here, no Node APIs.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  /** Mirror a theme preference (light/dark/system) onto the native chrome. */
  setNativeTheme: (source) => ipcRenderer.invoke('desktop:set-native-theme', source),  /** Open the plugin manager dialog window. */
  openPluginManager: () => ipcRenderer.invoke('desktop:open-plugin-manager'),  /** Resolve an install address (URL or local path) into candidate plugin packages. */
  resolvePlugin: (address) => ipcRenderer.invoke('desktop:plugin-resolve', address),
  /** Install a plugin package by its local directory path. */
  installPlugin: (path) => ipcRenderer.invoke('desktop:plugin-install', path),
  /** List the profile's installed plugin bundles. */
  listPlugins: () => ipcRenderer.invoke('desktop:plugin-list'),
  /** Uninstall a plugin by its bundle package name. */
  uninstallPlugin: (name) => ipcRenderer.invoke('desktop:plugin-uninstall', name),
  /** Quit the application (used after plugin config changes). */
  quitApp: () => ipcRenderer.invoke('desktop:quit'),
})

/** Sync the native title bar theme with the web app's data-ds-dark-theme attribute. */
function syncNativeTheme() {
  const body = document.body
  if (body === null) return
  const isDark = body.getAttribute('data-ds-dark-theme') === ''
  void ipcRenderer.invoke('desktop:set-native-theme', isDark ? 'dark' : 'light')
}

// Poll until the document body exists, then observe theme attribute changes.
function watchTheme() {
  if (document.body === null) {
    setTimeout(watchTheme, 10)
    return
  }
  syncNativeTheme()
  try {
    const observer = new MutationObserver(syncNativeTheme)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  } catch (_err) {
    // MutationObserver unavailable in the sandbox; fall back to polling.
    setInterval(syncNativeTheme, 500)
  }
}

watchTheme()
