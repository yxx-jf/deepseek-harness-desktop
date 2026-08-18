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
  setNativeTheme: (source) => ipcRenderer.invoke('desktop:set-native-theme', source),
})
