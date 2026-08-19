/**
 * Plugin-manager preload bridge. Leaner than the main preload: no theme
 * synchronization — the manager window manages its own appearance.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  /** Open the plugin manager dialog window. */
  openPluginManager: () => ipcRenderer.invoke('desktop:open-plugin-manager'),
  /** Resolve an install address (URL or local path) into candidate plugin packages. */
  resolvePlugin: (address) => ipcRenderer.invoke('desktop:plugin-resolve', address),
  /** Install a plugin package by its local directory path. */
  installPlugin: (path) => ipcRenderer.invoke('desktop:plugin-install', path),
  /** List the profile's installed plugin bundles. */
  listPlugins: () => ipcRenderer.invoke('desktop:plugin-list'),
  /** Uninstall a plugin by its bundle package name. */
  uninstallPlugin: (name) => ipcRenderer.invoke('desktop:plugin-uninstall', name),
  /** Quit (and relaunch) the application after plugin config changes. */
  quitApp: () => ipcRenderer.invoke('desktop:quit'),
  /** Search GitHub for dsh plugins by category. */
  searchPlugins: (category, query) => ipcRenderer.invoke('desktop:plugin-search', category, query),
  /** List all subscriptions. */
  listSubscriptions: () => ipcRenderer.invoke('desktop:plugin-subscriptions'),
  /** Subscribe (clone) a plugin repo by URL. */
  subscribePlugin: (repoUrl) => ipcRenderer.invoke('desktop:plugin-subscribe', repoUrl),
  /** Enable a subscribed bundle. */
  enablePlugin: (repoUrl, bundlePath) => ipcRenderer.invoke('desktop:plugin-enable', repoUrl, bundlePath),
  /** Disable an enabled bundle. */
  disablePlugin: (repoUrl, bundleName) => ipcRenderer.invoke('desktop:plugin-disable', repoUrl, bundleName),
  /** Unsubscribe (disable + delete files). */
  unsubscribePlugin: (repoUrl) => ipcRenderer.invoke('desktop:plugin-unsubscribe', repoUrl),
})