// Test: can the win32 dialog worker start under Electron's node and post IPC messages?
// Spawns worker.cjs (same as the app does), waits for 'showing', then kills it.
const { spawn } = require('child_process')
const path = require('path')

const workerPath = path.resolve(__dirname, '..', 'runtime-host', 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'worker.cjs')
const fs = require('fs')
const out = path.resolve(__dirname, '..', 'out_worker_test.txt')

fs.writeFileSync(out, 'node ' + process.version + '\nspawning: ' + process.execPath + ' ' + workerPath + '\n')

const child = spawn(process.execPath, [workerPath], {
  env: { ...process.env, DSH_DIALOG_TITLE: 'Select Workspace Directory' },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  windowsHide: true,
})

let gotMsg = false
const timer = setTimeout(() => {
  fs.writeFileSync(out, 'TIMEOUT: worker sent no message in 8s\n', { flag: 'a' })
  child.kill()
  process.exit(0)
}, 8000)

child.on('message', (msg) => {
  gotMsg = true
  fs.writeFileSync(out, 'GOT MESSAGE: ' + JSON.stringify(msg) + '\n', { flag: 'a' })
  // got 'showing' -> worker is alive and opening the dialog; kill it
  clearTimeout(timer)
  child.kill()
  process.exit(0)
})

child.on('exit', (code, signal) => {
  fs.writeFileSync(out, 'worker exited code=' + code + ' signal=' + signal + ' (after msg: ' + gotMsg + ')\n', { flag: 'a' })
  clearTimeout(timer)
})