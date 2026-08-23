/** Plugin manager dialog script. Two tabs: 社区 (GitHub browse), 已安装
 * (subscriptions + activation). Talks to the main process through the
 * sandboxed preload bridge (window.desktop).
 *
 * Community tab shows search results and asynchronously verifies dsh.bundle
 * for each repo, adding a badge on verified ones without blocking the list. */

/* ─────────────────────── Theme sync ────────────────────── */

/** Bridge exposed by the sandboxed preload. Declared FIRST so nothing below hits the TDZ. */
const api = window.desktop

/* ─────────────────────── i18n (zh/en) ────────────────────── */

const I18N = {
  zh: {
    'app.title': '🐋 插件管理',
    'app.tip': '浏览 · 订阅 · 启用 · 停用 · 卸载',
    'tab.community': '社区',
    'tab.installed': '已安装',
    'search.placeholder': '搜索插件…（按 ⭐ 热度降序）',
    'hint.community': 'DSH 社区插件',
    'pager.prev': '‹ 上一页',
    'pager.next': '下一页 ›',
    'pager.info': '第 {n} 页',
    'diag.started': '启动中…',
    'loading': '加载中…',
    'banner.text': '插件配置已更新，需要重启应用才能生效。',
    'restart': '立即重启',
    'modal.readmeLabel': '📖 README',
    'modal.readmeLoading': '加载中…',
    'modal.close': '关闭',
    'modal.readmeError': '（无 README 或加载失败）',
    'modal.readmeFail': '（加载 README 失败）',
    'modal.verified': '✓ 已验证 DSH 插件',
    'modal.notVerified': '未验证（可能不是 DSH 插件）',
    'modal.noDesc': '（无描述）',
    'status.enabled': '已启用',
    'status.subscribedDisabled': '已订阅 · 未启用',
    'repo.subscribed': '✓ 已订阅',
    'repo.subscribedTitle': '已订阅，可在「已安装」页启用',
    'actions.subscribe': '订阅',
    'repo.verified': '✓ 已验证',
    'list.noResults': '没有搜索到插件。试试其他关键词？',
    'list.noSubscriptions': '还没有订阅任何插件。去「社区」页浏览并订阅吧。',
    'diag.searching': '正在搜索社区插件{q}…',
    'diag.searchDone': '搜索完成（{s}s），{n} 个仓库{t}。已验证的插件会显示「已验证」标记',
    'diag.totalSuffix': '（共约 {n} 个）',
    'diag.searchFailed': '搜索失败',
    'diag.loadFailed': '加载失败',
    'error.loadFailed': '加载失败：{e}。请检查网络后重试。',
    'log.subscribing': '订阅 {name}…',
    'log.subscribeOk': '订阅成功 ✓（文件已下载，去「已安装」页启用）',
    'log.subscribeFail': '订阅失败',
    'log.subscribeError': '订阅异常',
    'log.loadSubsError': '读取订阅失败',
    'log.noCandidate': '【{name}】未找到可启用的插件包：该仓库可能不是 DSH 插件包，或 clone 已被删除',
    'log.enableFlowError': '启用流程异常',
    'log.enabling': '启用 {name}（{path}）…',
    'log.enableFail': '启用失败',
    'log.enableOk': '启用成功 ✓，重启后生效',
    'log.enableError': '启用异常',
    'log.disabling': '停用 {name}…',
    'log.disableFail': '停用失败',
    'log.disableOk': '已停用（文件保留，重启后失效）',
    'log.disableError': '停用异常',
    'log.uninstalling': '卸载 {url}…',
    'log.uninstallFail': '卸载失败',
    'log.uninstallOk': '已卸载（删除订阅与本地文件）',
    'log.uninstallError': '卸载异常',
    'actions.stop': '停用',
    'actions.enable': '启用',
    'actions.uninstall': '卸载',
    'js.loaded': 'JS 已加载。desktop API：{s}',
    'js.apiPresent': '存在',
    'js.apiMissing': '缺失',
    'js.ready': '插件管理已就绪',
    'js.initError': '初始化异常',
    'js.error': 'JS 错误',
    'js.promiseError': '未处理的 Promise 异常',
    'timeout.label': '搜索请求',
    'timeout.msg': '{label} 超时（{s}s）',
  },
  en: {
    'app.title': '🐋 Plugin Manager',
    'app.tip': 'Browse · Subscribe · Enable · Disable · Uninstall',
    'tab.community': 'Community',
    'tab.installed': 'Installed',
    'search.placeholder': 'Search plugins… (by ⭐ stars)',
    'hint.community': 'DSH Community Plugins',
    'pager.prev': '‹ Prev',
    'pager.next': 'Next ›',
    'pager.info': 'Page {n}',
    'diag.started': 'Starting…',
    'loading': 'Loading…',
    'banner.text': 'Plugin config changed — restart the app to apply.',
    'restart': 'Restart Now',
    'modal.readmeLabel': '📖 README',
    'modal.readmeLoading': 'Loading…',
    'modal.close': 'Close',
    'modal.readmeError': '(No README or failed to load)',
    'modal.readmeFail': '(Failed to load README)',
    'modal.verified': '✓ Verified DSH plugin',
    'modal.notVerified': 'Unverified (may not be a DSH plugin)',
    'modal.noDesc': '(no description)',
    'status.enabled': 'Enabled',
    'status.subscribedDisabled': 'Subscribed · Disabled',
    'repo.subscribed': '✓ Subscribed',
    'repo.subscribedTitle': 'Subscribed — enable in “Installed” tab',
    'actions.subscribe': 'Subscribe',
    'repo.verified': '✓ Verified',
    'list.noResults': 'No plugins found. Try another keyword?',
    'list.noSubscriptions': 'No subscriptions yet. Browse the Community tab to subscribe.',
    'diag.searching': 'Searching community plugins{q}…',
    'diag.searchDone': 'Search done ({s}s), {n} repos{t}. Verified plugins show a “✓ Verified” badge',
    'diag.totalSuffix': '(~{n} total)',
    'diag.searchFailed': 'Search failed',
    'diag.loadFailed': 'Failed to load',
    'error.loadFailed': 'Failed to load: {e}. Check your network and retry.',
    'log.subscribing': 'Subscribing to {name}…',
    'log.subscribeOk': 'Subscribed ✓ (files downloaded — enable in “Installed”)',
    'log.subscribeFail': 'Subscribe failed',
    'log.subscribeError': 'Subscribe error',
    'log.loadSubsError': 'Failed to read subscriptions',
    'log.noCandidate': '[{name}] No installable plugin package found: repo may not be a DSH plugin, or the clone was deleted',
    'log.enableFlowError': 'Enable flow error',
    'log.enabling': 'Enabling {name} ({path})…',
    'log.enableFail': 'Enable failed',
    'log.enableOk': 'Enabled ✓ — takes effect after restart',
    'log.enableError': 'Enable error',
    'log.disabling': 'Disabling {name}…',
    'log.disableFail': 'Disable failed',
    'log.disableOk': 'Disabled (files kept, inactive after restart)',
    'log.disableError': 'Disable error',
    'log.uninstalling': 'Uninstalling {url}…',
    'log.uninstallFail': 'Uninstall failed',
    'log.uninstallOk': 'Uninstalled (subscription & local files removed)',
    'log.uninstallError': 'Uninstall error',
    'actions.stop': 'Disable',
    'actions.enable': 'Enable',
    'actions.uninstall': 'Uninstall',
    'js.loaded': 'JS loaded. desktop API: {s}',
    'js.apiPresent': 'present',
    'js.apiMissing': 'missing',
    'js.ready': 'Plugin Manager ready',
    'js.initError': 'Initialization error',
    'js.error': 'JS error',
    'js.promiseError': 'Unhandled promise rejection',
    'timeout.label': 'Search request',
    'timeout.msg': '{label} timeout ({s}s)',
  },
}

let lang = 'zh'
function t(key, vars) {
  const map = I18N[lang] || I18N.zh
  let s = map[key] !== undefined ? map[key] : (I18N.zh[key] !== undefined ? I18N.zh[key] : key)
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split('{' + k + '}').join(String(v))
    }
  }
  return s
}

function loadLang() { return 'zh' }

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
  pager: document.getElementById('pager'),
  pagePrev: document.getElementById('pagePrev'),
  pageNext: document.getElementById('pageNext'),
  pageInfo: document.getElementById('pageInfo'),
  modalOverlay: document.getElementById('modalOverlay'),
  mdName: document.getElementById('mdName'),
  mdFullName: document.getElementById('mdFullName'),
  mdStars: document.getElementById('mdStars'),
  mdTopics: document.getElementById('mdTopics'),
  mdDesc: document.getElementById('mdDesc'),
  mdStatus: document.getElementById('mdStatus'),
  mdReadme: document.getElementById('mdReadme'),
  mdClose: document.getElementById('mdClose'),
  mdCloseBtn: document.getElementById('mdCloseBtn'),
  mdSubscribeBtn: document.getElementById('mdSubscribeBtn'),
  readmeLangBtn: document.getElementById('readmeLangBtn'),
}

/** Apply the current language to every data-i18n element and refresh dynamic text.
 *  reloadList=false 用于首次加载（随后会调 switchTab 触发搜索）。 */
function applyI18n(reloadList = true) {
  document.documentElement.lang = lang
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const raw = el.getAttribute('data-i18n')
    const sep = raw.indexOf('|')
    const key = sep >= 0 ? raw.slice(0, sep) : raw
    const attr = sep >= 0 ? raw.slice(sep + 1) : ''
    const val = t(key)
    if (attr === 'placeholder') el.placeholder = val
    else el.textContent = val
  }
  document.title = t('app.title') + ' · DeepSeek Harness'
  if (activeTab === 'community') {
    els.hint.textContent = t('hint.community')
    els.search.placeholder = t('search.placeholder')
    els.pager.classList.add('show')
    // 重新加载列表让按钮/徽章等动态文本跟随新语言（保留当前页）
    if (reloadList) searchPage(currentPage)
  }
  if (detailRepo) {
    // 语言切换时只更新详情弹窗的静态文本（按钮、状态等），不重新拉 README
    const repo = detailRepo
    els.mdName.textContent = repo.name
    els.mdFullName.textContent = repo.fullName
    els.mdStars.textContent = String(repo.stars)
    els.mdDesc.textContent = repo.description || t('modal.noDesc')
    updateDetailSubscribeBtn(repo)
  }
  else if (reloadList && activeTab === 'installed') renderInstalled()
}

function diag(msg, cls) {
  if (els.diag) {
    els.diag.textContent = msg
    els.diag.className = 'diag' + (cls ? ' ' + cls : '')
  }
}

// Surface any runtime error in the visible diag bar (and the log).
window.addEventListener('error', (e) => {
  diag(t('js.error') + '：' + (e && e.message ? e.message : String(e)), 'err')
})
window.addEventListener('unhandledrejection', (e) => {
  diag(t('js.promiseError') + '：' + String(e && e.reason), 'err')
})

/* ─────────────────────── Markdown renderer ────────────────────── */

/** Simple inline markdown → HTML renderer. Safe: escapes HTML first. */
function renderMarkdown(text) {
  if (!text) return ''
  // Escape HTML entities
  let h = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  // Code blocks (```) — must happen before other inline transforms
  h = h.replace(/```([\s\S]*?)```/g, (_m, code) => {
    return '<pre><code>' + code.trim() + '</code></pre>'
  })
  // Headings
  h = h.replace(/^##### (.+)$/gm, '<h5>$1</h5>')
  h = h.replace(/^#### (.+)$/gm, '<h4>$1</h4>')
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>')
  // Bold / italic
  h = h.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>')
  h = h.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>')
  h = h.replace(/__(.+?)__/g, '<strong>$1</strong>')
  h = h.replace(/_(.+?)_/g, '<em>$1</em>')
  // Inline code
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>')
  // Links
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  // Unordered lists
  h = h.replace(/^[\*\-]\s+(.+)$/gm, '<li>$1</li>')
  h = h.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
  // Ordered lists
  h = h.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>')
  h = h.replace(/(<li>.*<\/li>\n?)+/g, '<ol>$&</ol>')
  // Horizontal rules
  h = h.replace(/^---+/gm, '<hr>')
  // Paragraphs: double newlines
  h = h.replace(/\n\n+/g, '</p><p>')
  h = '<p>' + h + '</p>'
  // Clean up nested paragraphs around block elements
  h = h.replace(/<p><(\/?(?:ul|ol|li|h[1-5]|pre|hr|div))>/g, '<$1>')
  h = h.replace(/<(\/?(?:ul|ol|li|h[1-5]|pre|hr|div))><\/p>/g, '<$1>')
  // Single line breaks within inline text (not in blocks)
  h = h.replace(/\n/g, '<br>')
  return h
}

/** Active tab: 'community' | 'installed'. */
let activeTab = 'community'

/** Latest subscriptions record from the main process. */
let subscriptions = {}

/** Current page and query for community search. */
let currentPage = 1
let currentQuery = ''

function log(msg, cls = 'info') {
  const line = document.createElement('div')
  line.className = cls
  line.textContent = msg
  els.log.appendChild(line)
  els.log.scrollTop = els.log.scrollHeight
}

/** Human-friendly status text for a subscription. */
function subStatus(sub) {
  if (sub.enabledBundle) return { text: t('status.enabled'), cls: 'enabled' }
  return { text: t('status.subscribedDisabled'), cls: 'disabled' }
}

function setLoading() {
  els.list.innerHTML = '<div class="empty">' + t('loading') + '</div>'
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
    const timer = setTimeout(() => reject(new Error(t('timeout.msg', { label: label || '', s: (ms / 1000) }))), ms)
    promise.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
  })
}

function refreshBrowse() {
  setLoading()
  clearTimeout(searchTimer)
  searchTimer = setTimeout(async () => {
    currentQuery = els.search.value.trim()
    currentPage = 1
    await searchPage(1)
  }, 300)
}

async function searchPage(page) {
  currentPage = page
  setLoading()
  const query = currentQuery
  diag(t('diag.searching', { q: query ? '：' + query : '' }))
  const started = Date.now()
  try {
    const result = await withTimeout(api.searchPlugins('community', query, page), 15000, t('timeout.label'))
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    if (!result.ok) { errorBox(result.error || t('diag.searchFailed')); diag(t('diag.searchFailed') + '：' + (result.error || ''), 'err'); return }
    const repos = result.repos || []
    const totalCount = result.totalCount
    // 批量验证所有仓库，用于排序（已验证的排前面）
    diag(t('diag.searching', { q: '' }) + ' — 验证中…')
    const checks = await Promise.allSettled(repos.map(r => api.checkBundle(r.fullName, r.defaultBranch)))
    const verifiedIds = new Set()
    repos.forEach((r, i) => {
      const vr = checks[i]
      if (vr.status === 'fulfilled' && vr.value.ok && vr.value.reachable && vr.value.verified) {
        verifiedIds.add(r.id)
      }
    })
    // 排序：已验证的排前面，其余保持原有顺序
    repos.sort((a, b) => {
      const va = verifiedIds.has(a.id)
      const vb = verifiedIds.has(b.id)
      if (va && !vb) return -1
      if (!va && vb) return 1
      return 0
    })
    const totalTxt = totalCount ? t('diag.totalSuffix', { n: totalCount }) : ''
    diag(t('diag.searchDone', { s: elapsed, n: repos.length, t: totalTxt }), 'ok')
    renderRepos(repos, totalCount, verifiedIds)
  } catch (e) {
    diag(t('diag.loadFailed') + '：' + String(e), 'err')
    errorBox(t('error.loadFailed', { e: String(e) }))
  }
}

function updatePagerText() {
  if (els.pageInfo) els.pageInfo.textContent = t('pager.info', { n: currentPage })
}

function updatePager(totalCount, repoCount) {
  updatePagerText()
  els.pagePrev.disabled = currentPage <= 1
  // 如果返回少于 30 个，说明已到最后一页
  const hasMore = totalCount !== undefined
    ? currentPage * 30 < totalCount
    : repoCount >= 30
  els.pageNext.disabled = !hasMore
}

function renderRepos(repos, totalCount, verifiedIds) {
  if (!Array.isArray(repos) || repos.length === 0) {
    showEmpty(t('list.noResults'))
    updatePager(0, 0)
    return
  }
  els.list.innerHTML = ''
  for (const repo of repos) {
    const row = document.createElement('div')
    row.className = 'pkg'
    row.style.cursor = 'pointer'
    row.addEventListener('click', () => openDetail(repo))

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
    // 已验证标记（已批量排序，直接从 verifiedIds 取）
    if (verifiedIds && verifiedIds.has(repo.id)) {
      const badge = document.createElement('span')
      badge.className = 'status enabled'
      badge.textContent = t('repo.verified')
      nameLine.appendChild(badge)
    }
    const desc = document.createElement('div')
    desc.className = 'desc'
    desc.textContent = repo.description || t('modal.noDesc')
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
      btn.textContent = t('repo.subscribed')
      btn.disabled = true
      btn.title = t('repo.subscribedTitle')
    } else {
      btn.textContent = t('actions.subscribe')
      btn.addEventListener('click', (e) => { e.stopPropagation(); subscribeRepo(repo, btn) })
    }
    actions.appendChild(btn)

    row.appendChild(info)
    row.appendChild(actions)
    els.list.appendChild(row)
  }
  updatePager(totalCount, repos.length)
}

/** 异步检查仓库是否有 dsh.bundle，有则添加「已验证」标记。
 * 如果 row 为 null，只返回验证结果（用于详情页）。
 * 返回 true/false 表示是否已验证。 */
async function verifyBundle(repo, row) {
  try {
    const result = await api.checkBundle(repo.fullName, repo.defaultBranch)
    const verified = result.ok && result.reachable && result.verified
    if (verified && row) {
      const badge = document.createElement('span')
      badge.className = 'status enabled'
      badge.textContent = t('repo.verified')
      row.querySelector('.name').appendChild(badge)
    }
    return verified
  } catch { return false }
}

async function subscribeRepo(repo, btn) {
  btn.disabled = true
  log(t('log.subscribing', { name: repo.fullName }))
  try {
    const result = await api.subscribePlugin(repo.cloneUrl || repo.htmlUrl)
    if (!result.ok) { log((result.error || t('log.subscribeFail')), 'err'); btn.disabled = false; return }
    log(t('log.subscribeOk'), 'ok')
    await loadSubscriptions()
    showRestartHint(result.candidates && result.candidates.length > 0)
    // 如详情页打开，更新订阅按钮状态
    updateDetailSubscribeBtn(repo)
    refreshBrowse()
  } catch (e) {
    log(t('log.subscribeError') + '：' + String(e), 'err')
    btn.disabled = false
  }
}

/* ─────────────────────── Installed tab ────────────────────── */

async function loadSubscriptions() {
  try {
    const result = await api.listSubscriptions()
    if (result.ok) subscriptions = result.subscriptions || {}
  } catch (e) {
    log(t('log.loadSubsError') + '：' + String(e), 'err')
  }
}

async function renderInstalled() {
  setLoading()
  await loadSubscriptions()
  const entries = Object.entries(subscriptions)
  // Show subscriptions first, then other installed bundles not tied to a subscription.
  els.list.innerHTML = ''
  if (entries.length === 0) {
    showEmpty(t('list.noSubscriptions'))
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
      stop.textContent = t('actions.stop')
      stop.addEventListener('click', () => disablePlugin(repoUrl, sub.enabledBundle))
      actions.appendChild(stop)
    } else {
      // Need to pick a candidate bundle to enable. Re-scan from the clone.
      const enable = document.createElement('button')
      enable.textContent = t('actions.enable')
      enable.addEventListener('click', () => enableFlow(repoUrl, sub, enable))
      actions.appendChild(enable)
    }

    const uninstall = document.createElement('button')
    uninstall.className = 'danger'
    uninstall.textContent = t('actions.uninstall')
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
      log(t('log.noCandidate', { name: sub.repoName }), 'err')
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
    go.textContent = t('actions.enable')
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
    log(t('log.enableFlowError') + '：' + String(e), 'err')
    btn.disabled = false
  }
}

async function enableBundle(repoUrl, candidate) {
  log(t('log.enabling', { name: candidate.name, path: candidate.path }))
  try {
    const result = await api.enablePlugin(repoUrl, candidate.path)
    if (!result.ok) { log(result.error || t('log.enableFail'), 'err'); return }
    log(t('log.enableOk'), 'ok')
    showRestartHint(true)
    await renderInstalled()
  } catch (e) {
    log(t('log.enableError') + '：' + String(e), 'err')
  }
}

async function disablePlugin(repoUrl, bundleName) {
  log(t('log.disabling', { name: bundleName }))
  try {
    const result = await api.disablePlugin(repoUrl, bundleName)
    if (!result.ok) { log(result.error || t('log.disableFail'), 'err'); return }
    log(t('log.disableOk'), 'ok')
    showRestartHint(true)
    await renderInstalled()
  } catch (e) {
    log(t('log.disableError') + '：' + String(e), 'err')
  }
}

async function unsubscribe(repoUrl) {
  log(t('log.uninstalling', { url: repoUrl }))
  try {
    const result = await api.unsubscribePlugin(repoUrl)
    if (!result.ok) { log(result.error || t('log.uninstallFail'), 'err'); return }
    log(t('log.uninstallOk'), 'ok')
    await loadSubscriptions()
    const dirty = Object.keys(subscriptions).length > 0
    if (dirty) showRestartHint(true)
    renderInstalled()
  } catch (e) {
    log(t('log.uninstallError') + '：' + String(e), 'err')
  }
}

function showRestartHint(show) {
  if (show) els.restartBanner.classList.add('show')
}

/* ─────────────────────── Detail modal ────────────────────── */

/** Currently open repo in the detail modal, or null. */
let detailRepo = null
/** README text in both languages, or null. */
let readmeZh = null
let readmeEn = null
/** Which README language is currently shown: 'zh' or 'en'. */
let readmeLang = 'zh'

function openDetail(repo) {
  detailRepo = repo
  readmeZh = null
  readmeEn = null
  readmeLang = 'zh'
  els.readmeLangBtn.classList.remove('show')
  els.mdName.textContent = repo.name
  els.mdFullName.textContent = repo.fullName
  els.mdStars.textContent = String(repo.stars)
  els.mdDesc.textContent = repo.description || t('modal.noDesc')
  // Topics
  els.mdTopics.innerHTML = ''
  if (Array.isArray(repo.topics)) {
    for (const tagName of repo.topics) {
      const tag = document.createElement('span')
      tag.textContent = tagName
      els.mdTopics.appendChild(tag)
    }
  }
  // Status
  els.mdStatus.textContent = ''
  els.mdStatus.className = 'md-status'
  // README (placeholder)
  els.mdReadme.innerHTML = t('modal.readmeLoading')
  // Subscribe button
  updateDetailSubscribeBtn(repo)

  els.modalOverlay.classList.add('open')

  // Async bundle check
  verifyBundle(repo, null).then((verified) => {
    if (detailRepo !== repo) return
    if (verified) {
      els.mdStatus.innerHTML = '<span class="status enabled">' + t('modal.verified') + '</span>'
    } else {
      els.mdStatus.innerHTML = '<span class="status disabled">' + t('modal.notVerified') + '</span>'
    }
  })

  // Async README fetch (both zh and en)
  api.repoReadme(repo.fullName, repo.defaultBranch).then((result) => {
    if (detailRepo !== repo) return
    if (result.ok) {
      readmeZh = result.readmeZh || null
      readmeEn = result.readmeEn || null
      // 默认显示中文，没有中文则显示英文
      if (readmeZh) {
        els.mdReadme.innerHTML = renderMarkdown(readmeZh)
        readmeLang = 'zh'
        if (readmeEn) els.readmeLangBtn.classList.add('show')
      } else if (readmeEn) {
        els.mdReadme.innerHTML = renderMarkdown(readmeEn)
        readmeLang = 'en'
      } else {
        els.mdReadme.innerHTML = t('modal.readmeError')
      }
    } else {
      els.mdReadme.innerHTML = t('modal.readmeError')
    }
  }).catch(() => {
    if (detailRepo !== repo) return
    els.mdReadme.innerHTML = t('modal.readmeFail')
  })
}

function toggleReadmeLang() {
  if (readmeLang === 'zh' && readmeEn) {
    els.mdReadme.innerHTML = renderMarkdown(readmeEn)
    readmeLang = 'en'
  } else if (readmeLang === 'en' && readmeZh) {
    els.mdReadme.innerHTML = renderMarkdown(readmeZh)
    readmeLang = 'zh'
  }
}

function closeDetail() {
  detailRepo = null
  readmeZh = null
  readmeEn = null
  els.modalOverlay.classList.remove('open')
}

function updateDetailSubscribeBtn(repo) {
  if (!els.mdSubscribeBtn) return
  const sub = repo ? (subscriptions[repo.cloneUrl] || subscriptions[repo.htmlUrl]) : undefined
  if (sub !== undefined) {
    els.mdSubscribeBtn.textContent = t('modal.subscribed')
    els.mdSubscribeBtn.disabled = true
    els.mdSubscribeBtn.className = 'secondary'
  } else {
    els.mdSubscribeBtn.textContent = t('actions.subscribe')
    els.mdSubscribeBtn.disabled = false
    els.mdSubscribeBtn.className = ''
  }
}

/* ─────────────────────── Tab switching ────────────────────── */

function switchTab(tab) {
  activeTab = tab
  for (const b of els.tabButtons) b.classList.toggle('active', b.dataset.tab === tab)
  if (tab === 'installed') {
    els.toolbar.style.display = 'none'
    els.pager.classList.remove('show')
    renderInstalled()
  } else {
    els.toolbar.style.display = 'flex'
    els.pager.classList.add('show')
    els.hint.textContent = t('hint.community')
    els.search.placeholder = t('search.placeholder')
    refreshBrowse()
  }
}

/* ─────────────────────── Wire up events ────────────────────── */

for (const b of els.tabButtons) {
  b.addEventListener('click', () => switchTab(b.dataset.tab))
}
els.search.addEventListener('input', () => { if (activeTab !== 'installed') refreshBrowse() })
els.restartBtn.addEventListener('click', () => { api.quitApp() })

// Pagination
els.pagePrev.addEventListener('click', () => { if (currentPage > 1) searchPage(currentPage - 1) })
els.pageNext.addEventListener('click', () => { searchPage(currentPage + 1) })

// Language toggle
// (removed — UI language toggle was a misunderstanding, only README zh/en toggle remains)

// Detail modal
els.mdClose.addEventListener('click', closeDetail)
els.mdCloseBtn.addEventListener('click', closeDetail)
els.modalOverlay.addEventListener('click', (e) => { if (e.target === els.modalOverlay) closeDetail() })
els.mdSubscribeBtn.addEventListener('click', () => {
  if (!detailRepo) return
  subscribeRepo(detailRepo, els.mdSubscribeBtn)
})

// README language toggle
els.readmeLangBtn.addEventListener('click', toggleReadmeLang)

// Initial render.
try {
  lang = 'zh'
  applyI18n(false)
  diag(t('js.loaded', { s: (typeof api !== 'undefined' && api !== null) ? t('js.apiPresent') : t('js.apiMissing') }), typeof api !== 'undefined' && api !== null ? 'ok' : 'err')
  log(t('js.ready'), 'ok')
  switchTab('community')
} catch (e) {
  diag(t('js.initError') + '：' + String(e), 'err')
}