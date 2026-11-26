/**
 * Guizhi · browser half: the three-screen panel (Task 7).
 *
 * The DSH Web shell loads client plugins as plain scripts through
 * window.__ModuleLoader__.load; the factory receives require and must return a
 * cordis plugin descriptor ({ name, inject, apply }). There is NO build step in
 * this package: this file is the artifact, plain ES2020 + React.createElement.
 *
 * What it mounts (official slot seats, the same ones the shipped plugin/skill
 * pages use; docs/host-notes.md §5):
 * - a row in the shell's left sidebar list (sidebar.panellist);
 * - the page for that row (main, keyed by the same id), visible only while the
 *   row is selected.
 *
 * Three screens, all fed by GET api/guizhi/state polled every 3 seconds:
 * 1. 清爽：totals cards (插件/工具/技能/近30天未用) + the tool table (name,
 *    owners, 30-day usage; used30d === null renders 未知, NEVER 0) + rescan.
 * 2. 场景：six built-in chips + one-sentence custom text + save (POST scenarios).
 * 3. 地图：stage cards with capability dots (have green / missing yellow /
 *    redundant gray), click a capability to expand its evidence; bottom buttons
 *    call 查缺补漏/生成工具包/预览/应用/回滚 and 派单草稿, results shown in place.
 *
 * Transport: every request is document-relative (api/guizhi/...), never
 * root-absolute, because the host deploys the GUI under a base path and serves
 * routes at the origin root (docs/host-notes.md §6). The panel writes no files
 * itself: it only calls its own routes; the host half owns the data root.
 *
 * 真机面板验证 not-run（D5）：本任务只用 node --check 校验了本文件的语法，
 * 没有把插件装进测试 profile、没有重启 DSH、没有在真实 Web GUI 里渲染过。
 * 手动验证步骤（与 task-7-report.md 一致）：
 *   1) 按 docs/host-notes.md §8 建 guizhi-test profile 并安装本仓库；
 *   2) 打开侧栏「归置」，确认三屏可切换；
 *   3) 点「重新扫描」，清爽页数字应变化；用量未知时用量列显示「未知」；
 *   4) 浏览器 Network 面板确认 api/guizhi/state 每 3 秒返回 200。
 *
 * Failure policy: a shell without the slots seats logs a warning and leaves the
 * GUI untouched; a failed fetch only renders an error line, never throws into
 * the shell. An external plugin must never take the whole GUI boot down.
 *
 * @module @fanyingnie/dsh-guizhi/client
 */
(function () {
  'use strict'

  /** The row id, shared with the main slot key. */
  var PANEL_ID = 'guizhi'
  var SLOT_PANEL_LIST = 'sidebar.panellist'
  var SLOT_MAIN = 'main'
  /** Row order among the shell's global panel rows (Plugins 0, Schedule 10, skill center 30). */
  var PANEL_ORDER = 45
  /** The only version constant in the browser half. */
  var PLUGIN_VERSION = '0.1.0'
  var STYLE_MARKER = 'data-guizhi-style'
  /** Document-relative API prefix (never root-absolute; see module header). */
  var API_BASE = 'api/guizhi/'
  /** State poll interval: the design asks for every 2-5 seconds. */
  var POLL_MS = 3000
  /** Must match CUSTOM_MAX_CHARS in lib/scenarios.js (code points; the input
   *  maxlength below counts UTF-16 units, slightly stricter for astral chars). */
  var CUSTOM_MAX_CHARS = 200

  /**
   * The six built-in scenario chips. Duplicated from lib/scenarios.js on
   * purpose: the client half has no build step and may not import host modules.
   * Keep both lists in sync if the vocabulary changes (contract D7).
   */
  var SCENARIOS = [
    { id: 'content', title: '内容生产' },
    { id: 'design', title: '视觉设计' },
    { id: 'dev', title: '研发' },
    { id: 'research', title: '调研' },
    { id: 'office', title: '办公' },
    { id: 'daily', title: '日常' },
  ]

  var TABS = [
    { id: 'clean', title: '清爽' },
    { id: 'scenarios', title: '场景' },
    { id: 'map', title: '地图' },
  ]

  /** Human labels for the evidence keys the host half writes; unknown keys show raw. */
  var EVIDENCE_LABELS = {
    source: '来源',
    plugin: '插件',
    plugins: '插件',
    tool: '工具',
    tools: '工具',
    skill: '技能',
    skills: '技能',
    used30d: '近 30 天用量',
    lastUsedAt: '最后使用',
    at: '时间',
    refs: '引用',
    note: '说明',
  }

  var STATUS_LABELS = { have: '已有', missing: '缺', redundant: '冗余' }

  /** Inject the panel stylesheet once, tagged so re-apply never stacks sheets. */
  function ensureStyle() {
    if (typeof document === 'undefined' || !document.head) return
    if (document.querySelector('style[' + STYLE_MARKER + ']') !== null) return
    var style = document.createElement('style')
    style.setAttribute(STYLE_MARKER, '')
    style.textContent = [
      '.gz-root{display:flex;flex-direction:column;gap:14px;box-sizing:border-box;height:100%;padding:24px 28px;color:var(--dsw-alias-label-primary,#1f2328);background:var(--dsw-alias-bg-base,#fff);overflow:auto;font-size:13px}',
      '.gz-root *{box-sizing:border-box}',
      '.gz-head{display:flex;flex-direction:column;gap:10px;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.22));padding-bottom:12px}',
      '.gz-title-row{display:flex;align-items:baseline;gap:10px}',
      '.gz-title{margin:0;font-size:20px;line-height:1.25;font-weight:600;letter-spacing:.02em}',
      '.gz-version{font-size:12px;letter-spacing:.03em;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.gz-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.gz-tabs{display:flex;gap:8px}',
      '.gz-tab{border:1px solid transparent;background:transparent;color:inherit;font-size:13px;padding:6px 14px;border-radius:999px;cursor:pointer}',
      '.gz-tab:hover{background:var(--dsw-alias-bg-subtle,rgba(128,128,128,.10))}',
      '.gz-tab-on{background:var(--dsw-alias-bg-subtle,rgba(128,128,128,.14));border-color:var(--dsw-alias-border-subtle,rgba(128,128,128,.22));font-weight:600}',
      '.gz-body{display:flex;flex-direction:column;gap:16px;flex:1 1 auto;min-height:0}',
      '.gz-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.gz-section{display:flex;flex-direction:column;gap:10px}',
      '.gz-section-title{margin:0;font-size:14px;font-weight:600}',
      '.gz-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}',
      '.gz-card{border:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.22));border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:4px;background:var(--dsw-alias-bg-subtle,rgba(128,128,128,.05))}',
      '.gz-card-num{font-size:22px;line-height:1.1;font-weight:650}',
      '.gz-card-label{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.gz-card-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.gz-unknown{color:#b45309;font-weight:600}',
      '.gz-num{font-variant-numeric:tabular-nums}',
      '.gz-table-wrap{border:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.22));border-radius:10px;overflow:auto;max-height:52vh}',
      '.gz-table{width:100%;border-collapse:collapse;font-size:12.5px}',
      '.gz-table th,.gz-table td{text-align:left;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.14));vertical-align:top}',
      '.gz-table th{position:sticky;top:0;background:var(--dsw-alias-bg-base,#fff);font-weight:600}',
      '.gz-table tr:last-child td{border-bottom:none}',
      '.gz-tool-name{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap}',
      '.gz-tool-owners{color:var(--dsw-alias-label-secondary,#6b7280);word-break:break-word}',
      '.gz-warn-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px;font-size:12px;color:#92400e}',
      '.gz-warn-list li{word-break:break-word}',
      '.gz-chips{display:flex;flex-wrap:wrap;gap:8px}',
      '.gz-chip{border:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.3));background:transparent;color:inherit;border-radius:999px;padding:7px 16px;font-size:13px;cursor:pointer}',
      '.gz-chip:hover{background:var(--dsw-alias-bg-subtle,rgba(128,128,128,.10))}',
      '.gz-chip-on{background:rgba(37,99,235,.14);border-color:rgba(37,99,235,.55);color:#1d4ed8;font-weight:600}',
      '.gz-input{width:100%;border:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.3));border-radius:8px;background:transparent;color:inherit;font:inherit;padding:8px 10px;resize:vertical}',
      '.gz-input-inline{width:150px;padding:5px 8px;font-size:12px}',
      '.gz-counter{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);text-align:right}',
      '.gz-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;border-top:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.22));padding-top:12px}',
      '.gz-actions-flush{border-top:none;padding-top:0}',
      '.gz-btn{border:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.35));background:transparent;color:inherit;border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;white-space:nowrap}',
      '.gz-btn:hover{background:var(--dsw-alias-bg-subtle,rgba(128,128,128,.10))}',
      '.gz-btn:disabled{opacity:.5;cursor:default}',
      '.gz-btn-primary{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600}',
      '.gz-btn-primary:hover{background:#1d4ed8}',
      '.gz-stages{display:flex;flex-direction:column;gap:12px}',
      '.gz-stage{border:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.22));border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
      '.gz-stage-title{margin:0;font-size:14px;font-weight:600;display:flex;align-items:baseline;gap:8px}',
      '.gz-stage-id{font-size:11px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.gz-stage-empty{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.gz-caps{display:flex;flex-direction:column;gap:6px}',
      '.gz-cap-block{display:flex;flex-direction:column;gap:6px}',
      '.gz-cap{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.18));background:transparent;color:inherit;border-radius:8px;padding:7px 10px;font-size:12.5px;cursor:pointer;text-align:left;width:100%}',
      '.gz-cap:hover{background:var(--dsw-alias-bg-subtle,rgba(128,128,128,.08))}',
      '.gz-cap-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}',
      '.gz-cap-have .gz-cap-dot{background:#16a34a}',
      '.gz-cap-missing .gz-cap-dot{background:#d97706}',
      '.gz-cap-redundant .gz-cap-dot{background:#9ca3af}',
      '.gz-cap-title{flex:1 1 auto;word-break:break-word}',
      '.gz-cap-status{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.gz-cap-have .gz-cap-status{color:#15803d}',
      '.gz-cap-missing .gz-cap-status{color:#b45309}',
      '.gz-evidence{border-left:3px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.3));margin-left:6px;padding:4px 0 4px 12px;display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--dsw-alias-label-secondary,#4b5563)}',
      '.gz-evidence-line{word-break:break-word}',
      '.gz-map-meta{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.gz-result{border:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.25));border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-subtle,rgba(128,128,128,.04))}',
      '.gz-result-title{margin:0;font-size:13px;font-weight:600}',
      '.gz-result-item{font-size:12.5px;display:flex;flex-direction:column;gap:2px;padding:6px 0;border-bottom:1px dashed var(--dsw-alias-border-subtle,rgba(128,128,128,.18))}',
      '.gz-result-item:last-child{border-bottom:none}',
      '.gz-result-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);word-break:break-all}',
      '.gz-draft{width:100%;min-height:120px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}',
      '.gz-empty{border:1px dashed var(--dsw-alias-border-subtle,rgba(128,128,128,.35));border-radius:10px;padding:22px;display:flex;flex-direction:column;gap:8px;align-items:flex-start;color:var(--dsw-alias-label-secondary,#4b5563);font-size:13px}',
      '.gz-empty p{margin:0}',
      '.gz-status{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);border-top:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.18));padding-top:8px;min-height:22px}',
      '.gz-status-error{color:#b91c1c;font-weight:600}',
      '.gz-status-ok{color:#15803d}',
      '.gz-status-warn{color:#b45309}',
      '.gz-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280)}',
    ].join('\n')
    document.head.appendChild(style)
  }

  /**
   * The sidebar row icon.
   * @param {*} React
   * @returns {Function} React component
   */
  function createIcon(React) {
    return function GuizhiIcon() {
      return React.createElement(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true', focusable: 'false' },
        React.createElement('rect', { x: 3, y: 5, width: 18, height: 3.4, rx: 1.2, fill: 'currentColor', opacity: 0.95 }),
        React.createElement('rect', { x: 4.6, y: 10.4, width: 14.8, height: 3.4, rx: 1.2, fill: 'currentColor', opacity: 0.7 }),
        React.createElement('rect', { x: 6.2, y: 15.8, width: 11.6, height: 3.4, rx: 1.2, fill: 'currentColor', opacity: 0.5 }),
      )
    }
  }

  /**
   * One JSON request against the panel routes (document-relative). A non-2xx
   * answer becomes an Error carrying .status and .payload so the caller can
   * render warnings/codes without crashing the panel.
   * @param {string} path path below api/guizhi/
   * @param {{ method?: string, body?: unknown }} [options]
   * @returns {Promise<unknown>}
   */
  function apiRequest(path, options) {
    var settings = options || {}
    var init = { method: settings.method || 'GET', headers: { 'content-type': 'application/json' } }
    if (settings.body !== undefined) init.body = JSON.stringify(settings.body)
    return fetch(API_BASE + path, init).then(function (response) {
      return response.text().then(function (text) {
        var data = null
        if (text !== '') {
          try {
            data = JSON.parse(text)
          } catch (error) {
            data = null
          }
        }
        if (!response.ok) {
          var message = data !== null && typeof data.error === 'string' ? data.error : 'HTTP ' + response.status
          var failure = new Error(message)
          failure.status = response.status
          failure.payload = data
          throw failure
        }
        return data
      })
    })
  }

  /** Render one error for the status line. @param {unknown} error */
  function errorText(error) {
    if (error === null || error === undefined) return '未知错误'
    if (typeof error.message === 'string' && error.message !== '') return error.message
    return String(error)
  }

  /**
   * 30-day usage: null/undefined means UNKNOWN and must never read as 0 (D12).
   * The loose null check is intentional (fix round 1): both null and undefined
   * are "unknown", so every caller uses one rule.
   */
  function usageText(tool) {
    if (tool === null || typeof tool !== 'object') return '未知'
    return tool.used30d == null ? '未知' : String(tool.used30d) // eslint-disable-line eqeqeq
  }

  /** True when every scanned tool has null/undefined usage (the scan could not know). */
  function usageUnknown(scan) {
    if (scan === null || typeof scan !== 'object' || !Array.isArray(scan.tools) || scan.tools.length === 0) return true
    for (var index = 0; index < scan.tools.length; index += 1) {
      var tool = scan.tools[index]
      if (tool !== null && typeof tool === 'object' && tool.used30d != null) return false // eslint-disable-line eqeqeq
    }
    return true
  }

  /** Owners joined for display; empty means "not attributed", shown as a dash. */
  function ownersText(owners) {
    return Array.isArray(owners) && owners.length > 0 ? owners.join('、') : '—'
  }

  /** Display title for a scenario id. */
  function scenarioTitle(id) {
    for (var index = 0; index < SCENARIOS.length; index += 1) {
      if (SCENARIOS[index].id === id) return SCENARIOS[index].title
    }
    return String(id)
  }

  /** Human label for a capability status. */
  function statusLabel(status) {
    return STATUS_LABELS[status] || String(status || '')
  }

  /** One evidence value as plain text (arrays joined, objects JSON). */
  function evidenceValue(value) {
    if (value === null || value === undefined) return '—'
    if (Array.isArray(value)) {
      var parts = []
      for (var index = 0; index < value.length; index += 1) parts.push(evidenceValue(value[index]))
      return parts.join('、')
    }
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value)
      } catch (error) {
        return String(value)
      }
    }
    return String(value)
  }

  /** Evidence object -> readable "label: value" lines (never renders raw keys as English only). */
  function evidenceLines(evidence) {
    if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) return ['（无证据字段）']
    var keys = Object.keys(evidence)
    if (keys.length === 0) return ['（无证据字段）']
    var lines = []
    for (var index = 0; index < keys.length; index += 1) {
      var key = keys[index]
      lines.push((EVIDENCE_LABELS[key] || key) + '：' + evidenceValue(evidence[key]))
    }
    return lines
  }

  /**
   * The panel page: three tabs over one polled state document. Hooks are the
   * shell's React (React.createElement + useState/useEffect/useCallback); no
   * JSX and no build step.
   * @param {*} React
   * @returns {Function} React component
   */
  function createPage(React) {
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    return function GuizhiPage() {
      var viewHook = useState({ loading: true, error: null, data: null, updatedAt: null })
      var view = viewHook[0]
      var setView = viewHook[1]

      var tabHook = useState('clean')
      var tab = tabHook[0]
      var setTab = tabHook[1]

      var actionHook = useState({ busy: '', message: '', error: '', warnings: [] })
      var action = actionHook[0]
      var setAction = actionHook[1]

      var scenariosHook = useState({ selected: [], custom: '', touched: false })
      var scenarioDraft = scenariosHook[0]
      var setScenarioDraft = scenariosHook[1]

      var expandedHook = useState('')
      var expandedCap = expandedHook[0]
      var setExpandedCap = expandedHook[1]

      var previewHook = useState(null)
      var preview = previewHook[0]
      var setPreview = previewHook[1]

      var resultHook = useState(null)
      var result = resultHook[0]
      var setResult = resultHook[1]

      var draftHook = useState('')
      var draftText = draftHook[0]
      var setDraftText = draftHook[1]

      var snapshotHook = useState('')
      var snapshotId = snapshotHook[0]
      var setSnapshotId = snapshotHook[1]

      var copyHook = useState('')
      var copyHint = copyHook[0]
      var setCopyHint = copyHook[1]

      /** Fetch GET state once (also used by the 3s poll). */
      var loadState = useCallback(function () {
        return apiRequest('state')
          .then(function (payload) {
            setView({ loading: false, error: null, data: payload, updatedAt: Date.now() })
            return payload
          })
          .catch(function (error) {
            setView(function (previous) {
              return { loading: false, error: errorText(error), data: previous.data, updatedAt: previous.updatedAt }
            })
            return null
          })
      }, [])

      useEffect(function () {
        loadState()
        var timer = setInterval(loadState, POLL_MS)
        return function () {
          clearInterval(timer)
        }
      }, [loadState])

      var data = view.data
      var selections =
        data !== null && data !== undefined && data.selections !== null && typeof data.selections === 'object'
          ? data.selections
          : null
      var selectionsKey = selections === null ? '' : JSON.stringify(selections)

      useEffect(function () {
        if (selections === null) return
        if (scenarioDraft.touched) return
        setScenarioDraft({
          selected: Array.isArray(selections.selected) ? selections.selected.slice() : [],
          custom: typeof selections.custom === 'string' ? selections.custom : '',
          touched: false,
        })
      }, [selectionsKey])

      /**
       * Run one panel action: busy line, then a status message or a readable
       * error (with schema errors appended). Business warnings are surfaced.
       */
      function runAction(name, request, onSuccess) {
        setAction({ busy: name, message: '', error: '', warnings: [] })
        return Promise.resolve()
          .then(request)
          .then(function (payload) {
            var warnings = payload !== null && typeof payload === 'object' && Array.isArray(payload.warnings) ? payload.warnings : []
            setAction({ busy: '', message: name + '完成', error: '', warnings: warnings })
            loadState()
            if (typeof onSuccess === 'function') onSuccess(payload)
            return payload
          })
          .catch(function (error) {
            var payload = error !== null && error !== undefined ? error.payload : null
            var warnings = payload !== null && typeof payload === 'object' && Array.isArray(payload.warnings) ? payload.warnings : []
            var details = payload !== null && typeof payload === 'object' && Array.isArray(payload.errors) && payload.errors.length > 0 ? '（' + payload.errors.join('；') + '）' : ''
            setAction({ busy: '', message: '', error: errorText(error) + details, warnings: warnings })
            return null
          })
      }

      function onScan() {
        runAction('扫描', function () {
          return apiRequest('scan', { method: 'POST', body: {} })
        })
      }

      function onToggleChip(id) {
        setScenarioDraft(function (previous) {
          var selected = previous.selected.slice()
          var index = selected.indexOf(id)
          if (index >= 0) selected.splice(index, 1)
          else selected.push(id)
          return { selected: selected, custom: previous.custom, touched: true }
        })
      }

      function onCustomChange(event) {
        var value = event !== null && event !== undefined && event.target !== null && event.target !== undefined ? event.target.value : ''
        setScenarioDraft(function (previous) {
          return { selected: previous.selected.slice(), custom: String(value === undefined || value === null ? '' : value).slice(0, CUSTOM_MAX_CHARS), touched: true }
        })
      }

      function onSaveScenarios() {
        runAction('保存场景', function () {
          return apiRequest('scenarios', { method: 'POST', body: { selected: scenarioDraft.selected, custom: scenarioDraft.custom } })
        }, function (saved) {
          setScenarioDraft({
            selected: Array.isArray(saved.selected) ? saved.selected.slice() : [],
            custom: typeof saved.custom === 'string' ? saved.custom : '',
            touched: false,
          })
        })
      }

      function onGaps() {
        runAction('查缺补漏', function () {
          return apiRequest('gaps', { method: 'POST', body: {} })
        }, function (payload) {
          setResult({ kind: 'gaps', payload: payload })
        })
      }

      function onPack() {
        var map = data !== null && typeof data === 'object' && data.map !== null && typeof data.map === 'object' ? data.map : null
        var stages = map !== null && Array.isArray(map.stages) ? map.stages : []
        if (stages.length === 0) {
          setAction({ busy: '', message: '', error: '还没有地图阶段：先保存地图（或让会话里的 agent 调 stow_map_save）', warnings: [] })
          return
        }
        var stageIds = []
        for (var index = 0; index < stages.length; index += 1) stageIds.push(stages[index].id)
        runAction('生成工具包', function () {
          return apiRequest('pack', { method: 'POST', body: { stageIds: stageIds, title: '归置能力包' } })
        }, function (payload) {
          setResult({ kind: 'pack', payload: payload })
        })
      }

      function onPreview() {
        runAction('预览变更', function () {
          return apiRequest('preview', { method: 'POST', body: {} })
        }, function (payload) {
          setPreview(payload)
          setResult({ kind: 'preview', payload: payload })
        })
      }

      function onApply() {
        if (preview === null || typeof preview !== 'object' || !Array.isArray(preview.items)) {
          setAction({ busy: '', message: '', error: '请先点「预览变更」，再按预览的条目应用', warnings: [] })
          return
        }
        var ids = []
        for (var index = 0; index < preview.items.length; index += 1) ids.push(preview.items[index].id)
        runAction('应用', function () {
          return apiRequest('apply', { method: 'POST', body: { ids: ids } })
        }, function (payload) {
          if (payload !== null && typeof payload === 'object' && typeof payload.snapshotId === 'string' && payload.snapshotId !== '') {
            setSnapshotId(payload.snapshotId)
          }
          setResult({ kind: 'apply', payload: payload })
          setPreview(null)
        })
      }

      function onSnapshotChange(event) {
        setSnapshotId(event !== null && event !== undefined && event.target ? String(event.target.value) : '')
      }

      function onRollback() {
        var id = snapshotId.trim()
        if (id === '') {
          setAction({ busy: '', message: '', error: '请先填写快照 id（应用成功后会自动填入）', warnings: [] })
          return
        }
        runAction('回滚', function () {
          return apiRequest('rollback', { method: 'POST', body: { snapshotId: id } })
        }, function (payload) {
          setResult({ kind: 'rollback', payload: payload })
        })
      }

      function onDraft() {
        runAction('生成派单草稿', function () {
          return apiRequest('draft', { method: 'POST', body: { kind: 'dispatch' } })
        }, function (payload) {
          setDraftText(typeof payload.text === 'string' ? payload.text : '')
          setResult({ kind: 'draft', payload: payload })
          setCopyHint('')
        })
      }

      function onCopyDraft() {
        if (draftText === '') return
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(draftText).then(
              function () {
                setCopyHint('已复制到剪贴板，请自行粘贴发送。')
              },
              function () {
                setCopyHint('复制失败：请手动全选下方文本复制。')
              },
            )
            return
          }
        } catch (error) {
          // Fall through to the manual-copy hint.
        }
        setCopyHint('当前环境不支持剪贴板：请手动全选下方文本复制。')
      }

      /** Warning list shared by the scan summary and the action results. */
      function renderWarnings(warnings) {
        if (!Array.isArray(warnings) || warnings.length === 0) return null
        return h('ul', { className: 'gz-warn-list' }, warnings.map(function (message, index) {
          return h('li', { key: 'warn-' + index }, String(message))
        }))
      }

      /** State-level read warnings (e.g. a corrupt scan.json) are never hidden. */
      function renderStateWarnings() {
        if (data === null || !Array.isArray(data.warnings) || data.warnings.length === 0) return null
        return h('div', { className: 'gz-result' },
          h('h3', { className: 'gz-result-title' }, '状态读取提示'),
          renderWarnings(data.warnings),
        )
      }

      function renderStatusBar() {
        var items = []
        if (view.loading && data === null) items.push(h('span', { key: 'loading', className: 'gz-hint' }, '正在读取状态…'))
        if (view.error !== null) items.push(h('span', { key: 'load-error', className: 'gz-status-error' }, '状态读取失败：' + view.error))
        if (action.busy !== '') items.push(h('span', { key: 'busy', className: 'gz-hint' }, '正在执行：' + action.busy + '…'))
        if (action.message !== '') items.push(h('span', { key: 'message', className: 'gz-status-ok' }, action.message))
        if (action.error !== '') items.push(h('span', { key: 'action-error', className: 'gz-status-error' }, action.error))
        if (Array.isArray(action.warnings) && action.warnings.length > 0) {
          items.push(h('span', { key: 'action-warnings', className: 'gz-status-warn' }, '警告 ' + action.warnings.length + ' 条（见结果区）'))
        }
        if (view.updatedAt !== null) items.push(h('span', { key: 'updated', className: 'gz-hint' }, '更新于 ' + new Date(view.updatedAt).toLocaleTimeString()))
        return h('footer', { className: 'gz-status' }, items)
      }

      function renderClean() {
        var scan = data !== null && typeof data === 'object' && data.scan !== null && typeof data.scan === 'object' ? data.scan : null
        var header = h('div', { className: 'gz-bar' },
          h('h2', { className: 'gz-section-title' }, '本机家底'),
          h('button', { type: 'button', className: 'gz-btn gz-btn-primary', disabled: action.busy !== '', onClick: onScan }, '重新扫描'),
        )
        if (scan === null) {
          return h('div', { className: 'gz-section' }, header,
            h('div', { className: 'gz-empty' },
              h('p', {}, '还没有扫描结果。'),
              h('p', {}, '点右上角「重新扫描」采集本机的插件、工具、技能与近 30 天用量；扫描只读，不改 profile、不调用模型。'),
            ),
          )
        }
        var totals = scan.totals !== null && typeof scan.totals === 'object' ? scan.totals : {}
        var unknown = usageUnknown(scan)
        var cards = [
          { key: 'plugins', label: '插件', value: totals.plugins },
          { key: 'tools', label: '工具', value: totals.tools },
          { key: 'skills', label: '技能', value: totals.skills },
          { key: 'unused', label: '近 30 天未用', value: totals.unusedTools, hint: unknown ? '用量未知，只统计已知 0 次' : '已知 0 次调用的工具' },
        ]
        var toolRows = Array.isArray(scan.tools) ? scan.tools : []
        var scanWarnings = Array.isArray(scan.warnings) ? scan.warnings : []
        return h('div', { className: 'gz-section' }, header,
          h('div', { className: 'gz-cards' }, cards.map(function (card) {
            var value = card.value === null || card.value === undefined ? '未知' : String(card.value)
            return h('div', { className: 'gz-card', key: card.key },
              h('span', { className: 'gz-card-num' }, value),
              h('span', { className: 'gz-card-label' }, card.label),
              card.hint !== undefined ? h('span', { className: 'gz-card-hint' }, card.hint) : null,
            )
          })),
          unknown ? h('p', { className: 'gz-hint' }, '用量统计不可用：工具表用量列显示「未知」，绝不显示 0（Review Focus #2）。') : null,
          scanWarnings.length > 0 ? h('details', {}, h('summary', { className: 'gz-hint' }, '扫描提示 ' + scanWarnings.length + ' 条'), renderWarnings(scanWarnings)) : null,
          toolRows.length === 0
            ? h('div', { className: 'gz-empty' }, h('p', {}, '扫描结果里没有工具（宿主 tools 服务不可用？）'))
            : h('div', { className: 'gz-table-wrap' },
                h('table', { className: 'gz-table' },
                  h('thead', {}, h('tr', {},
                    h('th', {}, '工具'),
                    h('th', {}, '归属（owners）'),
                    h('th', {}, '近 30 天用量'),
                  )),
                  h('tbody', {}, toolRows.map(function (tool, index) {
                    var valid = tool !== null && typeof tool === 'object'
                    var name = valid && typeof tool.name === 'string' ? tool.name : '(无效行)'
                    var unknownCell = valid && tool.used30d == null // eslint-disable-line eqeqeq
                    return h('tr', { key: 'tool-' + index },
                      h('td', { className: 'gz-tool-name' }, name),
                      h('td', { className: 'gz-tool-owners' }, ownersText(valid ? tool.owners : null)),
                      h('td', { className: unknownCell ? 'gz-unknown' : 'gz-num' }, usageText(valid ? tool : null)),
                    )
                  })),
                ),
              ),
          h('p', { className: 'gz-hint' }, '扫描时间：' + (typeof scan.generatedAt === 'string' ? scan.generatedAt : '未知') + (unknown ? '；用量未知（used30d = null）' : '')),
        )
      }

      function renderScenarios() {
        var selected = scenarioDraft.selected
        var custom = scenarioDraft.custom
        var savedText = '还没有保存过场景选择'
        if (selections !== null) {
          var savedSelected = Array.isArray(selections.selected) ? selections.selected : []
          savedText = '已保存：' + (savedSelected.length > 0 ? savedSelected.map(scenarioTitle).join('、') : '无内置场景')
          if (typeof selections.custom === 'string' && selections.custom !== '') savedText += '；自定义：' + selections.custom
        }
        return h('div', { className: 'gz-section' },
          h('h2', { className: 'gz-section-title' }, '选场景'),
          h('p', { className: 'gz-hint' }, '内置 6 个场景可多选；自定义一句话用于补充。保存只写本机状态，不生成工作流、不调用模型。'),
          h('div', { className: 'gz-chips' }, SCENARIOS.map(function (scenario) {
            var active = selected.indexOf(scenario.id) >= 0
            return h('button', {
              key: scenario.id,
              type: 'button',
              className: 'gz-chip' + (active ? ' gz-chip-on' : ''),
              'aria-pressed': active ? 'true' : 'false',
              onClick: function () {
                onToggleChip(scenario.id)
              },
            }, scenario.title)
          })),
          h('div', {},
            h('textarea', {
              className: 'gz-input',
              rows: 2,
              maxLength: CUSTOM_MAX_CHARS,
              placeholder: '用一句话描述你的场景（200 字以内）',
              value: custom,
              onChange: onCustomChange,
            }),
            h('div', { className: 'gz-counter' }, String(custom.length) + ' / ' + String(CUSTOM_MAX_CHARS)),
          ),
          h('div', { className: 'gz-actions gz-actions-flush' },
            h('button', { type: 'button', className: 'gz-btn gz-btn-primary', disabled: action.busy !== '', onClick: onSaveScenarios }, '保存场景'),
            h('span', { className: 'gz-hint' }, savedText),
          ),
        )
      }

      function renderResult() {
        if (result === null || typeof result !== 'object') return null
        var payload = result.payload !== null && typeof result.payload === 'object' ? result.payload : {}
        if (result.kind === 'gaps') {
          var gapItems = Array.isArray(payload.items) ? payload.items : []
          return h('div', { className: 'gz-result' },
            h('h3', { className: 'gz-result-title' }, '查缺补漏：' + String(gapItems.length) + ' 条安装提案'),
            gapItems.length === 0 && !payload.error ? h('p', { className: 'gz-hint' }, '没有匹配到缺口提案。') : null,
            gapItems.map(function (item, index) {
              return h('div', { className: 'gz-result-item', key: 'gap-' + index },
                h('span', {}, String(item.title || item.id)),
                h('span', { className: 'gz-result-meta' }, String(item.effect || '')),
              )
            }),
            renderWarnings(payload.warnings),
            payload.error ? h('p', { className: 'gz-status-warn' }, '目录错误：' + String(payload.error)) : null,
            payload.stale === true ? h('p', { className: 'gz-status-warn' }, '目录刷新失败，当前使用过期缓存的结果') : null,
          )
        }
        if (result.kind === 'pack') {
          var pack = payload.pack !== null && typeof payload.pack === 'object' ? payload.pack : {}
          return h('div', { className: 'gz-result' },
            h('h3', { className: 'gz-result-title' }, '工具包已生成'),
            h('p', { className: 'gz-result-meta' }, '路径：' + String(payload.path || '')),
            h('p', { className: 'gz-result-meta' },
              'id ' + String(pack.id || '') +
              '；工具 ' + String(Array.isArray(pack.tools) ? pack.tools.length : 0) + ' 个' +
              '；技能 ' + String(Array.isArray(pack.skills) ? pack.skills.length : 0) + ' 个' +
              '；阶段 ' + String(Array.isArray(pack.stageIds) ? pack.stageIds.length : 0) + ' 个'),
            h('p', { className: 'gz-hint' }, 'v1 只导出声明文件，不安装任何插件、不改 profile。'),
          )
        }
        if (result.kind === 'preview') {
          var previewItems = Array.isArray(payload.items) ? payload.items : []
          return h('div', { className: 'gz-result' },
            h('h3', { className: 'gz-result-title' }, '预览：将应用 ' + String(previewItems.length) + ' 条'),
            h('p', { className: 'gz-result-meta' }, 'hash：' + String(payload.hash || '').slice(0, 16) + '…'),
            previewItems.map(function (item, index) {
              return h('div', { className: 'gz-result-item', key: 'preview-' + index },
                h('span', {}, String(item.title || item.id)),
                h('span', { className: 'gz-result-meta' }, String(item.kind || '') + ' · ' + String(item.effect || '')),
              )
            }),
            h('p', { className: 'gz-hint' }, '点「应用」会按这批条目执行；应用前会先建快照。'),
          )
        }
        if (result.kind === 'apply') {
          var applied = Array.isArray(payload.applied) ? payload.applied : []
          return h('div', { className: 'gz-result' },
            h('h3', { className: 'gz-result-title' }, '已应用 ' + String(applied.length) + ' 条'),
            typeof payload.snapshotId === 'string' && payload.snapshotId !== '' ? h('p', { className: 'gz-result-meta' }, '快照 id（已填入回滚框）：' + payload.snapshotId) : null,
            renderWarnings(payload.warnings),
          )
        }
        if (result.kind === 'rollback') {
          return h('div', { className: 'gz-result' },
            h('h3', { className: 'gz-result-title' }, '已回滚'),
            h('p', { className: 'gz-result-meta' }, 'restored: ' + String(payload.restored === true)),
          )
        }
        if (result.kind === 'draft') {
          return h('div', { className: 'gz-result' },
            h('h3', { className: 'gz-result-title' }, '派单草稿（面板不会代发）'),
            h('textarea', { className: 'gz-input gz-draft', readOnly: true, value: typeof payload.text === 'string' ? payload.text : draftText }),
            h('div', { className: 'gz-actions gz-actions-flush' },
              h('button', { type: 'button', className: 'gz-btn', onClick: onCopyDraft }, '复制到剪贴板'),
              h('span', { className: 'gz-hint' }, copyHint),
            ),
          )
        }
        return null
      }

      function renderMapActions() {
        var busy = action.busy !== ''
        return h('div', { className: 'gz-actions' },
          h('button', { type: 'button', className: 'gz-btn', disabled: busy, onClick: onGaps }, '查缺补漏'),
          h('button', { type: 'button', className: 'gz-btn', disabled: busy, onClick: onPack }, '生成工具包'),
          h('button', { type: 'button', className: 'gz-btn', disabled: busy, onClick: onPreview }, '预览变更'),
          h('button', { type: 'button', className: 'gz-btn gz-btn-primary', disabled: busy, onClick: onApply }, '应用'),
          h('input', { className: 'gz-input gz-input-inline', placeholder: '快照 id', value: snapshotId, onChange: onSnapshotChange, 'aria-label': '快照 id' }),
          h('button', { type: 'button', className: 'gz-btn', disabled: busy, onClick: onRollback }, '回滚'),
          h('button', { type: 'button', className: 'gz-btn', disabled: busy, onClick: onDraft }, '生成派单草稿'),
        )
      }

      function renderMap() {
        var map = data !== null && typeof data === 'object' && data.map !== null && typeof data.map === 'object' ? data.map : null
        var stages = map !== null && Array.isArray(map.stages) ? map.stages : []
        var scenarioList = map !== null && Array.isArray(map.scenarios) ? map.scenarios : []
        var meta = '还没有选场景；可以先在「场景」页选择并保存。'
        if (scenarioList.length > 0) {
          meta = '已选场景：' + scenarioList.map(scenarioTitle).join('、')
          if (typeof map.custom === 'string' && map.custom !== '') meta += '；自定义：' + map.custom
        }
        var body
        if (stages.length === 0) {
          body = h('div', { className: 'gz-empty' },
            h('p', {}, '还没有工作流地图。'),
            h('p', {}, 'v1 的拆解由会话里的 agent 完成：让它调用 stow_map_save 保存阶段与能力点；面板负责展示、查缺、打包、预览与应用。'),
          )
        } else {
          body = h('div', { className: 'gz-stages' }, stages.map(function (stage) {
            var capabilities = stage !== null && typeof stage === 'object' && Array.isArray(stage.capabilities) ? stage.capabilities : []
            return h('section', { className: 'gz-stage', key: 'stage-' + String(stage.id) },
              h('h3', { className: 'gz-stage-title' }, String(stage.title || stage.id), h('span', { className: 'gz-stage-id' }, String(stage.id))),
              capabilities.length === 0
                ? h('p', { className: 'gz-stage-empty' }, '这个阶段还没有能力点')
                : h('div', { className: 'gz-caps' }, capabilities.map(function (capability, index) {
                    var capId = capability !== null && capability !== undefined && capability.id !== undefined ? String(capability.id) : String(index)
                    var openKey = String(stage.id) + '::' + capId
                    var open = expandedCap === openKey
                    return h('div', { className: 'gz-cap-block', key: 'cap-' + capId },
                      h('button', {
                        type: 'button',
                        className: 'gz-cap gz-cap-' + String(capability !== null && capability !== undefined ? capability.status || '' : ''),
                        'aria-expanded': open ? 'true' : 'false',
                        onClick: function () {
                          setExpandedCap(open ? '' : openKey)
                        },
                      },
                        h('span', { className: 'gz-cap-dot' }),
                        h('span', { className: 'gz-cap-title' }, String((capability !== null && capability !== undefined && capability.title) || capId)),
                        h('span', { className: 'gz-cap-status' }, statusLabel(capability !== null && capability !== undefined ? capability.status : '')),
                      ),
                      open
                        ? h('div', { className: 'gz-evidence' }, evidenceLines(capability !== null && capability !== undefined ? capability.evidence : null).map(function (line, lineIndex) {
                            return h('div', { className: 'gz-evidence-line', key: 'ev-' + lineIndex }, line)
                          }))
                        : null,
                    )
                  })),
            )
          }))
        }
        return h('div', { className: 'gz-section' },
          h('h2', { className: 'gz-section-title' }, '工作流地图'),
          h('p', { className: 'gz-map-meta' }, meta),
          body,
          renderResult(),
          renderMapActions(),
        )
      }

      function renderBody() {
        if (tab === 'scenarios') return renderScenarios()
        if (tab === 'map') return renderMap()
        return renderClean()
      }

      return h('div', { className: 'gz-root', 'data-dsh-plugin': 'guizhi' },
        h('header', { className: 'gz-head' },
          h('div', { className: 'gz-title-row' },
            h('h1', { className: 'gz-title' }, '归置'),
            h('span', { className: 'gz-version' }, '版本 ' + PLUGIN_VERSION),
          ),
          h('p', { className: 'gz-sub' }, '把本机 DSH 的插件、工具、技能、场景与缺口整理清楚。面板只读扫描 + 写本机状态，不改 profile、不代发。'),
          h('nav', { className: 'gz-tabs', 'aria-label': '归置三屏' }, TABS.map(function (item) {
            return h('button', {
              key: item.id,
              type: 'button',
              className: 'gz-tab' + (tab === item.id ? ' gz-tab-on' : ''),
              'aria-pressed': tab === item.id ? 'true' : 'false',
              onClick: function () {
                setTab(item.id)
              },
            }, item.title)
          })),
        ),
        h('div', { className: 'gz-body' }, renderStateWarnings(), renderBody()),
        renderStatusBar(),
      )
    }
  }

  /**
   * Assemble the cordis descriptor the module loader mounts.
   * @param {*} React
   * @returns {{ name: string, inject: string[], apply: (ctx: *) => void }}
   */
  function createPanelPlugin(React) {
    var Icon = createIcon(React)
    var Page = createPage(React)
    return {
      name: 'guizhi',
      inject: ['slots'],
      /**
       * @param {*} ctx client root context (service: slots)
       * @returns {void}
       */
      apply(ctx) {
        ensureStyle()
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') {
          console.warn('[guizhi] slots service missing; panel not mounted')
          return
        }
        var disposers = []
        try {
          disposers.push(
            ctx.slots.inject(SLOT_PANEL_LIST, function () {
              return ctx.slots.register(
                { name: SLOT_PANEL_LIST, id: PANEL_ID, order: PANEL_ORDER, label: function () { return '归置' } },
                Icon,
              )
            }),
          )
          disposers.push(
            ctx.slots.inject(SLOT_MAIN, function () {
              return ctx.slots.register({ name: SLOT_MAIN, key: PANEL_ID }, Page)
            }),
          )
        } catch (error) {
          console.warn('[guizhi] panel registration failed:', error)
        }
        if (typeof ctx.effect === 'function') {
          ctx.effect(function () {
            return function () {
              for (var index = 0; index < disposers.length; index += 1) {
                try {
                  disposers[index]()
                } catch (error) {
                  console.warn('[guizhi] slot dispose failed:', error)
                }
              }
              disposers.length = 0
            }
          }, 'guizhi: ui mounts')
        }
      },
    }
  }

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: '@fanyingnie/dsh-guizhi',
      factory(require) {
        return createPanelPlugin(require('react'))
      },
    })
  }
})()
