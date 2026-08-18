/** Dev preview for the splash window: simulate bootstrap progress in a real
 * Electron window and capture screenshots. Run without packaging:
 *   electron scripts/preview-splash.mjs
 */
import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(DESKTOP, 'tmp')
mkdirSync(OUT_DIR, { recursive: true })

const ZIP_URL = 'https://github.com/yxx-jf/deepseek-harness-desktop/releases/download/v0.1.0/dsh-runtime-0.1.0-rc.5-42cf7a3c467e.zip'

/** The exact DOM patch the main process drives (mirrors src/splash.ts). */
function patchScript(progress) {
  const percent = progress.percent ?? 0
  let detail = progress.detail ?? ''
  const attempt = /^attempt (\d+) of (.+)$/u.exec(detail)
  if (attempt !== null) detail = `第 ${attempt[1]} 次尝试：${attempt[2]}`
  const status = statusText(progress)
  return `(() => {
    document.documentElement.dataset.phase = ${JSON.stringify(progress.phase)};
    const fill = document.getElementById('progress-fill');
    if (fill !== null) fill.style.width = ${JSON.stringify(`${percent}%`)};
    const label = document.getElementById('progress-label');
    if (label !== null) label.textContent = ${JSON.stringify(status)};
    const pct = document.getElementById('progress-percent');
    if (pct !== null) pct.textContent = ${JSON.stringify(progress.percent === undefined ? '' : `${percent}%`)};
    const detail = document.getElementById('progress-detail');
    if (detail !== null) detail.textContent = ${JSON.stringify(detail)};
  })()`
}

function statusText(progress) {
  switch (progress.phase) {
    case 'fetching-manifest': return '正在检查更新…'
    case 'downloading': return '正在下载运行环境…'
    case 'extracting': return '正在解压运行环境…'
    case 'installing': return '正在安装运行环境…'
    case 'ready': return '运行环境就绪'
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const steps = [
  { phase: 'fetching-manifest' },
  { phase: 'downloading', percent: 0, detail: `attempt 1 of ${ZIP_URL}` },
  { phase: 'downloading', percent: 3, detail: `attempt 1 of ${ZIP_URL}` },
  { phase: 'downloading', percent: 0, detail: `attempt 2 of ${ZIP_URL}` },
  { phase: 'downloading', percent: 12, detail: `attempt 2 of ${ZIP_URL}` },
  { phase: 'downloading', percent: 38, detail: `attempt 2 of ${ZIP_URL}` },
  { phase: 'downloading', percent: 64, detail: `attempt 2 of ${ZIP_URL}` },
  { phase: 'downloading', percent: 89, detail: `attempt 2 of ${ZIP_URL}` },
  { phase: 'downloading', percent: 100, detail: `attempt 2 of ${ZIP_URL}` },
  { phase: 'extracting', percent: 5 },
  { phase: 'extracting', percent: 40 },
  { phase: 'extracting', percent: 90 },
  { phase: 'extracting', percent: 100 },
  { phase: 'installing', percent: 90 },
  { phase: 'ready', percent: 100 },
]

async function shot(win, name) {
  const image = await win.webContents.capturePage()
  const file = join(OUT_DIR, name)
  writeFileSync(file, image.toPNG())
  console.log(`saved ${file}`)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 520,
    height: 380,
    frame: false,
    thickFrame: false,
    hasShadow: true,
    resizable: false,
    show: true,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  })
  await win.loadFile(join(DESKTOP, 'resources', 'splash.html'))
  let lastKey = ''
  for (const step of steps) {
    const key = `${step.phase}:${step.percent ?? ''}:${step.detail ?? ''}`
    if (key === lastKey) continue
    lastKey = key
    await win.webContents.executeJavaScript(patchScript(step))
    if (step.phase === 'downloading' && step.percent === 3) await shot(win, 'splash-preview.png')
    await sleep(650)
  }
  await shot(win, 'splash-preview-ready.png')
  app.quit()
})
