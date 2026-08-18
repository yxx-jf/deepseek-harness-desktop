import { defineConfig } from 'tsdown'

/** Bundle the Electron main entry while preserving Electron as a runtime builtin. */
export default defineConfig({
  // The extraction worker is a second bundle loaded by main via new Worker.
  entry: ['lib/types/main.js', 'lib/types/extract-worker.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Electron stays a runtime builtin; fflate (runtime bootstrap) and
  // electron-updater (app self-update) must be inlined because the packaged
  // shell ships no node_modules.
  deps: { neverBundle: ['electron'], alwaysBundle: ['fflate', 'electron-updater'] },
})
