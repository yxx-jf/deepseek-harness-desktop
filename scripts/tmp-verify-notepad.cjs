const cp = require('child_process')
const os = require('os')
const path = require('path')

const file = path.join(os.homedir(), '.dsh', 'settings.yaml')
const psCmd = 'Start-Process -FilePath notepad.exe -ArgumentList ' + "'" + file + "'"
console.log('PS CMD:', psCmd)
cp.execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], { windowsHide: true }, (e, o, er) => {
  console.log('err:', e ? e.message : 'none')
  console.log('stdout len:', o.length)
  console.log('stderr len:', er.length)
  console.log('DONE - notepad should be open now')
})