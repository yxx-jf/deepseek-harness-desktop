/** Plugin manager dialog script. Two tabs: 社区 (GitHub browse), 已安装
 * (subscriptions + activation). Talks to the main process through the
 * sandboxed preload bridge (window.desktop).
 *
 * Community tab shows search results and asynchronously verifies dsh.bundle
 * for each repo, adding a badge on verified ones without blocking the list. */
 */

/* ─────────────────────── Theme sync ────────────────────── */

/** Bridge exposed by the sandboxed preload. Declared FIRST so nothing below hits the TDZ. */
const api = window.desktop

/** Apply theme from the query param or the native theme API. */
async function applyTheme(source) {
  const isDark = source === 'dark' || (source === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.body.setAttribute('data-ds-dark-theme', String(isDark))
}

// Initialize theme from query param, then listen for changes.
void (async () => {
  const params = new URLSearchParams(window.location.search)
  const themeParam = params.get('theme')
  if (themeParam) {
    applyTheme(themeParam)
  } else if (api?.getTheme) {
    api.getTheme().then(applyTheme)
  }
})()
api?.onThemeChanged?.(applyTheme)
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  api?.getTheme().then(applyTheme)
})
const els = {
  tabs: document.getElementById('tabs'),
  tabButtons: Array.from(document.querySelectorAll('.tab')),
  search: document.getElementById('search'),
  toolbar: document.getElementById('toolbar'),
  hint: document.getElementById('hint'),
  list: document.getElementById('list'),
  loading: document.getElementById('loading'),
  restartBanner: document.getElementById('restartBanner'),
  restartBtn: document.getElementById('restartBtn'),
  log: document.getElementById('log'),
  diag: document.getElementById('diag'),
}

function diag(msg, cls) {
  if (els.diag) {
    els.diag.textContent = msg
    els.diag.className = 'diag' + (cls ? ' ' + cls : '')
  }
}

// Surface any runtime error in the visible diag bar (and the log).
window.addEventListener('error', (e) => {
  diag('JS 错误：' + (e && e.message ? e.message : String(e)), 'err')
})
window.addEventListener('unhandledrejection', (e) => {
  diag('未处理的 Promise 异常：' + String(e && e.reason), 'err')
})

/** Active tab: 'community' | 'installed'. */
let activeTab = 'community'

/** Latest subscriptions record from the main process. */
let subscriptions = {}

function log(msg, cls = 'info') {
  const line = document.createElement('div')
  line.className = cls
  line.textContent = msg
  els.log.appendChild(line)
  els.log.scrollTop = els.log.scrollHeight
}

/** Human-friendly status text for a subscription. */
function subStatus(sub) {
  if (sub.enabledBundle) return { text: '已启用', cls: 'enabled' }
  return { text: '已订阅 · 未启用', cls: 'disabled' }
}

function setLoading() {
  els.list.innerHTML = '<div class="empty">加载中…</div>'
}

function showEmpty(text) {
  els.list.innerHTML = `<div class="empty">${text}</div>`
}

function errorBox(text) {
  els.list.innerHTML = `<div class="empty" style="color:#f26a6a">${text}</div>`
}

/* ─────────────────────── GitHub browse (community) ────────────────────── */

let searchTimer = null
/** Wrap an IPC promise with a hard timeout so a stalled fetch can't hang the UI. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' 超时（' + (ms / 1000) + 's）')), ms)
    promise.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
  })
}

function refreshBrowse() {
  setLoading()
  clearTimeout(searchTimer)
  searchTimer = setTimeout(async () => {
    const query = els.search.value.trim()
    diag('正在搜索社区插件' + (query ? '：' + query : '') + '…')
    const started = Date.now()
    try {
      const result = await withTimeout(api.searchPlugins('community', query), 15000, '搜索请求')
      const elapsed = ((Date.now() - started) / 1000).toFixed(1)
      if (!result.ok) { errorBox(result.error || '搜索失败'); diag('搜索失败：' + (result.error || ''), 'err'); return }
      const repos = result.repos || []
      diag('搜索完成（' + elapsed + 's），找到 ' + repos.length + ' 个仓库。已验证的插件会显示「已验证」标记', 'ok')
      renderRepos(repos)
    } catch (e) {
      diag('加载失败：' + String(e), 'err')
      errorBox('加载失败：' + String(e) + '。请检查网络后重试。')
    }
  }, 300)
}

function renderRepos(repos) {
  if (!Array.isArray(repos) || repos.length === 0) {
    showEmpty('没有搜索到插件。试试其他关键词？')
    return
  }
  els.list.innerHTML = ''
  for (const repo of repos) {
    const row = document.createElement('div')
    row.className = 'pkg'

    const sub = subscriptions[repo.cloneUrl] || subscriptions[repo.htmlUrl]
    const info = document.createElement('div')
    info.className = 'info'
    const nameLine = document.createElement('div')
    nameLine.className = 'name'
    nameLine.textContent = repo.name
    const stars = document.createElement('span')
    stars.className = 'stars'
    stars.textContent = String(repo.stars)
    nameLine.appendChild(stars)
    const desc = document.createElement('div')
    desc.className = 'desc'
    desc.textContent = repo.description || '（无描述）'
    const url = document.createElement('div')
    url.className = 'url'
    url.textContent = repo.fullName
    info.appendChild(nameLine)
    info.appendChild(desc)
    info.appendChild(url)

    const actions = document.createElement('div')
    actions.className = 'actions'
    const btn = document.createElement('button')
    if (sub !== undefined) {
      btn.className = 'secondary'
      btn.textContent = '✓ 已订阅'
      btn.disabled = true
      btn.title = '已订阅，可在「已安装」页启用'
    } else {
      btn.textContent = '订阅'
      btn.addEventListener('click', () => subscribeRepo(repo, btn))
    }
    actions.appendChild(btn)

    row.appendChild(info)
    row.appendChild(actions)
    els.list.appendChild(row)

    // 异步验证 dsh.bundle，不阻塞显示
    verifyBundle(repo, row)
  }
}

/** 异步检查仓库是否有 dsh.bundle，有则添加「已验证」标记。 */
async function verifyBundle(repo, row) {
  try {
    const result = await api.checkBundle(repo.fullName, repo.defaultBranch)
    if (result.ok && result.reachable && result.verified) {
      const badge = document.createElement('span')
      badge.className = 'status enabled'
      badge.textContent = '✓ 已验证'
      row.querySelector('.name').appendChild(badge)
    }
  } catch { /* 静默失败，不阻塞 UI */ }
}

async function subscribeRepo(repo, btn) {
  btn.disabled = true
  log(`订阅 ${repo.fullName}…`)
  try {
    const result = await api.subscribePlugin(repo.cloneUrl || repo.htmlUrl)
    if (!result.ok) { log(result.error || '订阅失败', 'err'); btn.disabled = false; return }
    log('订阅成功 ✓（文件已下载，去「已安装」页启用）', 'ok')
    await loadSubscriptions()
    showRestartHint(result.candidates && result.candidates.length > 0)
    refreshBrowse()
  } catch (e) {
    log('订阅异常：' + String(e), 'err')
    btn.disabled = false
  }
}

/* ─────────────────────── Installed tab ────────────────────── */

async function loadSubscriptions() {
  try {
    const result = await api.listSubscriptions()
    if (result.ok) subscriptions = result.subscriptions || {}
  } catch (e) {
    log('读取订阅失败：' + String(e), 'err')
  }
}

async function renderInstalled() {
  setLoading()
  await loadSubscriptions()
  const entries = Object.entries(subscriptions)
  // Show subscriptions first, then other installed bundles not tied to a subscription.
  els.list.innerHTML = ''
  if (entries.length === 0) {
    showEmpty('还没有订阅任何插件。去「社区」页浏览并订阅吧。')
    return
  }
  for (const [repoUrl, sub] of entries) {
    const row = document.createElement('div')
    row.className = 'pkg'

    const info = document.createElement('div')
    info.className = 'info'
    const nameLine = document.createElement('div')
    nameLine.className = 'name'
    nameLine.textContent = sub.repoName
    const st = subStatus(sub)
    const status = document.createElement('span')
    status.className = 'status ' + st.cls
    status.textContent = st.text
    nameLine.appendChild(status)
    const desc = document.createElement('div')
    desc.className = 'url'
    desc.textContent = repoUrl
    info.appendChild(nameLine)
    info.appendChild(desc)

    const actions = document.createElement('div')
    actions.className = 'actions'

    if (sub.enabledBundle) {
      const stop = document.createElement('button')
      stop.className = 'secondary'
      stop.textContent = '停用'
      stop.addEventListener('click', () => disablePlugin(repoUrl, sub.enabledBundle))
      actions.appendChild(stop)
    } else {
      // Need to pick a candidate bundle to enable. Re-scan from the clone.
      const enable = document.createElement('button')
      enable.textContent = '启用'
      enable.addEventListener('click', () => enableFlow(repoUrl, sub, enable))
      actions.appendChild(enable)
    }

    const uninstall = document.createElement('button')
    uninstall.className = 'danger'
    uninstall.textContent = '卸载'
    uninstall.addEventListener('click', () => unsubscribe(repoUrl))
    actions.appendChild(uninstall)

    row.appendChild(info)
    row.appendChild(actions)
    els.list.appendChild(row)
  }
}

/** Enable flow: scan the clone for candidate bundles; if several, let the user pick. */
async function enableFlow(repoUrl, sub, btn) {
  btn.disabled = true
  try {
    const result = await api.resolvePlugin(sub.clonePath)
    if (!result.ok || !result.candidates || result.candidates.length === 0) {
      log('【' + sub.repoName + '】未找到可启用的插件包：该仓库可能不是 DSH 插件包，或 clone 已被删除', 'err')
      btn.disabled = false
      return
    }
    const candidates = result.candidates
    if (candidates.length === 1) {
      await enableBundle(repoUrl, candidates[0])
      return
    }
    // Multiple candidates: ask which bundle to enable via a temporary inline picker.
    const pick = document.createElement('select')
    for (const c of candidates) {
      const opt = document.createElement('option')
      opt.value = c.path
      opt.textContent = c.name
      pick.appendChild(opt)
    }
    const go = document.createElement('button')
    go.textContent = '启用'
    go.addEventListener('click', async () => {
      const chosen = candidates.find(c => c.path === pick.value)
      await enableBundle(repoUrl, chosen)
      go.disabled = true
    })
    const row = btn.closest('.pkg')
    const actions = row.querySelector('.actions')
    actions.prepend(pick, go)
    btn.style.display = 'none'
  } catch (e) {
    log('启用流程异常：' + String(e), 'err')
    btn.disabled = false
  }
}

async function enableBundle(repoUrl, candidate) {
  log(`启用 ${candidate.name}（${candidate.path}）…`)
  try {
    const result = await api.enablePlugin(repoUrl, candidate.path)
    if (!result.ok) { log(result.error || '启用失败', 'err'); return }
    log('启用成功 ✓，重启后生效', 'ok')
    showRestartHint(true)
    await renderInstalled()
  } catch (e) {
    log('启用异常：' + String(e), 'err')
  }
}

async function disablePlugin(repoUrl, bundleName) {
  log(`停用 ${bundleName}…`)
  try {
    const result = await api.disablePlugin(repoUrl, bundleName)
    if (!result.ok) { log(result.error || '停用失败', 'err'); return }
    log('已停用（文件保留，重启后失效）', 'ok')
    showRestartHint(true)
    await renderInstalled()
  } catch (e) {
    log('停用异常：' + String(e), 'err')
  }
}

async function unsubscribe(repoUrl) {
  log(`卸载 ${repoUrl}…`)
  try {
    const result = await api.unsubscribePlugin(repoUrl)
    if (!result.ok) { log(result.error || '卸载失败', 'err'); return }
    log('已卸载（删除订阅与本地文件）', 'ok')
    await loadSubscriptions()
    const dirty = Object.keys(subscriptions).length > 0
    if (dirty) showRestartHint(true)
    renderInstalled()
  } catch (e) {
    log('卸载异常：' + String(e), 'err')
  }
}

function showRestartHint(show) {
  if (show) els.restartBanner.classList.add('show')
}

/* ─────────────────────── Tab switching ────────────────────── */

function switchTab(tab) {
  activeTab = tab
  for (const b of els.tabButtons) b.classList.toggle('active', b.dataset.tab === tab)
  if (tab === 'installed') {
    els.toolbar.style.display = 'none'
    renderInstalled()
  } else {
    els.toolbar.style.display = 'flex'
    els.hint.textContent = 'DSH 社区插件'
    els.search.placeholder = '搜索插件…（按 ⭐ 热度降序）'
    refreshBrowse()
  }
}

/* ─────────────────────── Wire up events ────────────────────── */

for (const b of els.tabButtons) {
  b.addEventListener('click', () => switchTab(b.dataset.tab))
}
els.search.addEventListener('input', () => { if (activeTab !== 'installed') refreshBrowse() })
els.restartBtn.addEventListener('click', () => { api.quitApp() })

// Initial render.
try {
  diag('JS 已加载。desktop API：' + (typeof api !== 'undefined' && api !== null ? '存在' : '缺失'), typeof api !== 'undefined' && api !== null ? 'ok' : 'err')
  log('插件管理已就绪', 'ok')
  switchTab('community')
} catch (e) {
  diag('初始化异常：' + String(e), 'err')
}