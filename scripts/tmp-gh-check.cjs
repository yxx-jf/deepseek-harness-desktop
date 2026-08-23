const cp = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const token = (() => {
  const env = path.join(ROOT, '.env')
  if (fs.existsSync(env)) { const m = fs.readFileSync(env, 'utf8').match(/^GH_TOKEN=(.+)$/m); if (m) return m[1].trim() }
  return process.env.GH_TOKEN
})()

function curl(args) {
  return cp.execFileSync('curl.exe', ['-s', '-H', 'Authorization: Bearer ' + token, '-H', 'Accept: application/vnd.github.v3+json', ...args], { encoding: 'utf8' })
}

// Search for dsh-plugin, dsh-theme, dsh-skin repos
const topics = ['dsh-plugin', 'dsh-theme', 'dsh-skin']
for (const topic of topics) {
  console.log('\n=== topic:', topic, '===')
  const r = JSON.parse(curl(['https://api.github.com/search/repositories?q=topic:' + topic + '&sort=stars&order=desc&per_page=5']))
  for (const repo of (r.items || []).slice(0, 5)) {
    console.log('---')
    console.log('name:', repo.full_name, '| stars:', repo.stargazers_count)
    console.log('desc:', (repo.description || '').slice(0, 100))
    console.log('topics:', (repo.topics || []).join(', '))
    // Try to read package.json
    try {
      const raw = JSON.parse(curl(['https://api.github.com/repos/' + repo.full_name + '/contents/package.json']))
      const pkg = JSON.parse(Buffer.from(raw.content, 'base64').toString())
      console.log('pkg.name:', pkg.name)
      console.log('has dsh:', !!pkg.dsh)
      if (pkg.dsh) {
        console.log('dsh keys:', Object.keys(pkg.dsh))
        console.log('has dsh.bundle:', !!pkg.dsh.bundle)
        if (pkg.dsh.bundle) console.log('bundle keys:', Object.keys(pkg.dsh.bundle))
      }
      // Check structure: is the plugin in root or a subdirectory?
      console.log('has workspaces:', !!pkg.workspaces)
    } catch (e) {
      console.log('no package.json:', String(e).slice(0, 80))
    }
  }
}