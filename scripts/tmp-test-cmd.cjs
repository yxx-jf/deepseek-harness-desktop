const cp = require('child_process')
const os = require('os')
const path = require('path')

const file = path.join(os.homedir(), '.dsh', 'settings.yaml')

// Test: cmd /c start from execFile
console.log('=== Test: cmd /c start ===')
cp.execFile('cmd.exe', ['/c', 'start', '', 'notepad.exe', file], { windowsHide: true }, (e, o, er) => {
  console.log('err:', e ? e.message : 'none')
  console.log('stdout:', o.length > 0 ? o.slice(0, 200) : '(empty)')
  console.log('stderr:', er.length > 0 ? er.slice(0, 200) : '(empty)')
  setTimeout(() => {
    try {
      const ps = cp.execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Process notepad).Count'], { encoding: 'utf8' }).trim()
      console.log('notepad processes after cmd start:', ps)
    } catch (e) {
      console.log('no notepad process')
    }
  }, 500)
})