const fs = require('fs')
const path = require('path')

const base = 'C:/Users/yyx/AppData/Local/Programs/DeepSeek Harness'
const p = path.join(base, 'resources/host/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/native-path-opener.js')
console.log('exists:', fs.existsSync(p))
if (fs.existsSync(p)) {
  const t = fs.readFileSync(p, 'utf8')
  const i = t.indexOf('async function openWindowsPath')
  console.log(t.slice(i, i + 500))
  console.log('---')
  console.log('has Start-Process:', t.includes('Start-Process'))
  console.log('has blocking execFile notepad:', t.includes("run('notepad.exe'"))
  console.log('has powershell Invoke-Item:', t.includes('Invoke-Item'))
}
const asar = path.join(base, 'resources/app.asar')
console.log('asar exists:', fs.existsSync(asar))
// Read version from asar
if (fs.existsSync(asar)) {
  const buf = fs.readFileSync(asar, 'latin1')
  const m = buf.match(/"version"\s*:\s*"([^"]+)"/)
  console.log('version from asar:', m ? m[1] : 'not found')
}