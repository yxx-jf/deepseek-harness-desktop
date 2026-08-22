const fs = require('fs')
const path = require('path')
const lib = path.resolve(__dirname, '..', 'runtime-host', 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib')
const worker = fs.readFileSync(path.join(lib, 'worker.cjs'), 'utf8')
const index = fs.readFileSync(path.join(lib, 'index.js'), 'utf8')

const markers = {
  'worker.process-send-throw': ['if (process.send === void 0) throw new Error("win32-dialog-worker must run as a child process with an IPC channel");', worker],
  'worker.send-bind': ['const send = process.send.bind(process);', worker],
  'index.stdio': ['const stdio = [\n\t\t"ignore",\n\t\t"inherit",\n\t\t"inherit",\n\t\t"ipc"\n\t];', index],
  'index.msg-handler': ['worker.on("message", (message) => {', index],
}

for (const [name, [needle, src]] of Object.entries(markers)) {
  console.log(`== ${name} ==`)
  if (src.includes(needle)) {
    console.log('  MATCH (single occurrence): ' + (src.split(needle).length - 1))
    // print a window around it raw-ish
  } else {
    console.log('  NO MATCH')
    // show what's there
    const probe = name.includes('msg-handler') ? 'worker.on' : name.includes('send-bind') ? 'const send' : name.includes('stdio') ? 'const stdio' : 'process.send'
    const idx = src.indexOf(probe)
    if (idx >= 0) console.log('  near: ' + JSON.stringify(src.slice(idx, idx + 160)))
  }
}

// print exact message-handler start
const i = index.indexOf('worker.on("message"')
console.log('MSG start bytes: ' + JSON.stringify(index.slice(i, i + 40)))