process.stdout.write('node ' + process.version + '\n')
try {
  const k = require('./runtime-host/node_modules/koffi')
  process.stdout.write('koffi OK: ' + typeof k + '\n')
} catch (e) {
  process.stdout.write('koffi FAIL: ' + e.message.split('\n')[0] + '\n')
  process.stdout.write('stack: ' + e.stack.split('\n').slice(0, 3).join('\n') + '\n')
}