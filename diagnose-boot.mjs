// 诊断脚本:真实引导 web profile, dump loader entries + clientModules 扫描结果
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import os from 'node:os'

// 显式解析 app-boot 入口(upstream workspace 内, 其内部 import 相对自身解析)
const appBootEntry = resolve('packages/boot/app-boot/lib/index.js')
const appBoot = await import(pathToFileURL(appBootEntry).href)
const { boot, loadProfile, healProfilesModuleFallback, loadOptionalPatches, composeEntries } = appBoot

// provideCmdline:与真实 runProfile 的 prepare 钩子一致
const cmdlineEntry = resolve('packages/boot/cmdline/lib/index.js')
const { provideCmdline } = await import(pathToFileURL(cmdlineEntry).href)

const HOME = resolve(os.homedir())
const DSH_HOME = resolve(HOME, '.dsh')
const PROFILE = 'web'
const NAME = 'dsh'

// INSTALL_ANCHOR = apps/cli/package.json (与 profile-boot 一致)
const INSTALL_ANCHOR = fileURLToPath(pathToFileURL(resolve('apps/cli/package.json')).href)
const homePatch = () => join(DSH_HOME, 'cordis.patch.yml')

async function main() {
  console.log('=== 1) loadProfile / prepareProfile ===')
  const profile = loadProfile(NAME, PROFILE, INSTALL_ANCHOR)
  console.log('profile.dir =', profile.dir)
  console.log('profile.packageName =', profile.packageName)
  console.log('profile.layers =', profile.layers.map((l) => `${l.packageName} @ ${l.packageDir}`))

  console.log('\n=== 2) healProfilesModuleFallback ===')
  await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, profile })

  const profileNodeModules = join(profile.dir, 'node_modules', '@deepseek-ai')
  console.log('profile node_modules/@deepseek-ai exists?', profileNodeModules)
  // 列出 profile node_modules 下 @deepseek-ai 的 client 包
  const { readdirSync, existsSync } = await import('node:fs')
  if (existsSync(profileNodeModules)) {
    const names = readdirSync(profileNodeModules)
    console.log('  count =', names.length)
    console.log('  client-ish =', names.filter((n) => n.includes('client')).join(', ') || '(none)')
  } else {
    console.log('  MISSING @deepseek-ai dir under profile node_modules')
  }

  console.log('\n=== 3) patches 组合 ===')
  const homePatches = loadOptionalPatches(NAME, homePatch()) ?? []
  const bundlePatches = profile.layers.flatMap((layer) => layer.patches)
  const overlays = []
  const rows = new Map()
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const allPatches = [...bundlePatches, ...profile.patches, ...homePatches, ...overlays]
  console.log('bundlePatches =', bundlePatches.length)
  console.log('profile.patches =', profile.patches.length)
  console.log('homePatches =', homePatches.length)
  console.log('composed rows =', [...rows.keys()])

  console.log('\n=== 4) boot() ===')
  const rootConfig = join(profile.dir, 'cordis.yml')
  const ctx = await boot(NAME, rootConfig, allPatches, (hostCtx) => {
    // prepare 钩子:与真实 runProfile 一致, 提供 cmdlineArgs/appExit/appReady
    provideCmdline(hostCtx, {
      args: [],
      exit: (code) => { console.log('  [appExit]', code) },
      ready: { onReady: (listener) => { /* noop */ return () => {} } },
    })
  })
  console.log('boot OK. baseUrl =', ctx.baseUrl)

  console.log('\n=== 5) loader entries ===')
  const loader = ctx.get('loader')
  const entries = [...loader.entries()]
  console.log('entry count =', entries.length)
  // 打印 client 相关条目的 baseUrl 与 internal resolve 能力
  const internal = loader.internal
  console.log('loader.internal.version =', internal?.version)
  console.log('loader.internal.resolveSync type =', typeof Reflect.get(internal ?? {}, 'resolveSync'))
  for (const e of entries) {
    const fiber = e.fiber !== undefined
    const disabled = e.disabled
    if (/client|web-app|webserver|connection|hmr|modules/.test(e.options.name)) {
      const baseUrl = e.parent?.tree?.ctx?.baseUrl
      console.log(`  ${e.options.name}  fiber=${fiber} disabled=${disabled} id=${e.id} base=${baseUrl}`)
    }
  }

  console.log('\n=== 5b) 逐包对比源码 v2 形式 vs 正确 v1 形式的 resolveSync ===')
  const baseUrl = 'file:///C:/Users/yxx/.dsh/profiles/web/'
  const clientEntries = entries.filter((e) => e.options.name.startsWith('@deepseek-ai/dsh-client'))
  console.log('client 条目数 =', clientEntries.length)
  let v2Fail = 0
  let v1Fail = 0
  for (const e of clientEntries) {
    const name = e.options.name
    // 源码 locatePkgJson 的 v2 分支写法
    let v2ok = false
    try {
      internal.resolveSync(baseUrl, { specifier: name, attributes: {} })
      v2ok = true
    } catch { v2ok = false }
    if (!v2ok) v2Fail++
    // 正确的 v1 三参写法
    let v1ok = false
    try {
      internal.resolveSync(name, baseUrl, {})
      v1ok = true
    } catch { v1ok = false }
    if (!v1ok) v1Fail++
    console.log(`  ${name}  v2=${v2ok ? 'OK' : 'FAIL'}  v1=${v1ok ? 'OK' : 'FAIL'}`)
  }
  console.log(`\n统计: v2(源码写法)失败 ${v2Fail}/${clientEntries.length}, v1(正确写法)失败 ${v1Fail}/${clientEntries.length}`)

  console.log('\n=== 6) clientModules graph ===')
  try {
    const cm = ctx.clientModules
    if (cm) {
      const g = cm.graph()
      console.log('graph =', JSON.stringify(g))
    } else {
      console.log('ctx.clientModules undefined!')
      console.log('available services:', Object.keys(ctx).filter((k) => k.includes('client') || k.includes('module')).join(', ') || '(none matching)')
    }
  } catch (err) {
    console.log('clientModules error:', err.message)
  }

  await ctx.fiber.dispose().catch(() => {})
  console.log('\n=== done ===')
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
