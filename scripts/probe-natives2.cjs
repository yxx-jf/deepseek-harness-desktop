const fs = require('fs')
const path = require('path')
const lib = path.resolve(__dirname, '..', 'runtime-host', 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib')
const index = fs.readFileSync(path.join(lib, 'index.js'), 'utf8')

// find the block from 'worker.on("message"' through the closing '});' that precedes worker.on("error"
const i = index.indexOf('worker.on("message"')
const j = index.indexOf('worker.on("error"')
console.log('MSG HANDLER FULL [' + i + '..' + j + ']:')
console.log(JSON.stringify(index.slice(i, j)))
console.log()
// Also show what's right before it (to get the indentation of worker.on)
const k = index.lastIndexOf('\n', i)
console.log('PREV LINE: ' + JSON.stringify(index.slice(k, i)))
// spawn block
const s = index.indexOf('const stdio = [')
console.log()
console.log('STDIO BLOCK:')
console.log(JSON.stringify(index.slice(s, s + 100)))