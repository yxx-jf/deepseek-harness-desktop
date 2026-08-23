const fs = require('fs')
const path = require('path')

const dirs = [
  'upstream/packages/client/ui-theme',
  'upstream/packages/client/ui-primitives',
  'upstream/packages/client/web',
]
const found = []
for (const d of dirs) {
  if (!fs.existsSync(d)) { console.log('missing', d); continue }
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(f)
      } else if (/\.(css|scss|ts|tsx)$/.test(e.name) && fs.statSync(f).size < 500000) {
        try {
          const t = fs.readFileSync(f, 'utf8')
          if (t.includes('--dsw')) {
            found.push(f.replace(/\\/g, '/'))
            console.log(f.toString())
          }
        } catch {}
      }
    }
  }
  walk(d)
}