const fs = require('fs')
const path = require('path')
const koffiPath = path.resolve(__dirname, '..', 'runtime-host', 'node_modules', 'koffi')
const out = path.resolve(__dirname, '..', 'out_koffi.txt')
fs.writeFileSync(out, 'node ' + process.version + '\nloaded from: ' + koffiPath + '\n')
try {
  const k = require(koffiPath)
  fs.writeFileSync(out, 'koffi OK: ' + typeof k + '\n', { flag: 'a' })
} catch (e) {
  fs.writeFileSync(out, 'koffi FAIL: ' + (e.message || '').split('\n')[0] + '\n', { flag: 'a' })
  fs.writeFileSync(out, 'stack: ' + (e.stack || '').split('\n').slice(0, 3).join('\n'), { flag: 'a' })
}