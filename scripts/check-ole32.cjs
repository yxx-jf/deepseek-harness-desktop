const fs = require('fs')
const path = require('path')
const out = path.resolve(__dirname, '..', 'out_ole32.txt')
fs.writeFileSync(out, 'setup OK\n')
try {
  const k = require(path.resolve(__dirname, '..', 'runtime-host', 'node_modules', 'koffi'))
  fs.writeFileSync(out, 'koffi OK\n', { flag: 'a' })
} catch (e) {
  fs.writeFileSync(out, 'FAIL: ' + (e.message || '').split('\n')[0] + '\n', { flag: 'a' })
}