/**
 * Guizhi · browser half: the three-screen panel (整理 / 场景 / 工作流).
 *
 * Loaded as a plain script through window.__ModuleLoader__.load; the factory
 * receives require and returns a cordis descriptor ({ name, inject, apply }).
 * No build step, no JSX: plain ES2020 + React.createElement only.
 *
 * Visual layer (polish pass): brand header with a live system-status dot and
 * the rescan action; segmented tabs with aria-selected and a sliding
 * indicator; four stat cards with inline SVG icons; a sticky-header tool table
 * with owner chips and a 30-day usage mini bar; scenario chips with inline
 * icons; a timeline-style capability map with evidence grids; a sticky map
 * action bar; and one unified 「操作结果」result card. Every colour/size comes
 * from DSH theme variables with a safe fallback, so the panel follows the
 * shell's light/dark theme. docs/ui-preview.html is a static, non-running
 * visual reference (fake data) for human review.
 *
 * What it mounts (official slot seats, the same ones the shipped plugin/skill
 * pages use; docs/host-notes.md §5):
 * - a row in the shell's left sidebar list (sidebar.panellist);
 * - the page for that row (main, keyed by the same id), visible only while the
 *   row is selected.
 *
 * Three screens, all fed by GET api/guizhi/state polled every 3 seconds:
 * 1. 整理：totals cards (插件/工具/技能/近30天未用) + the tool table (name,
 *    owners, 30-day usage; used30d === null renders 未知, NEVER 0) + rescan.
 * 2. 场景：six built-in chips + one-sentence custom text + save (POST scenarios).
 * 3. 工作流：stage cards with capability dots (have green / missing yellow /
 *    redundant gray), click a capability to expand its 精简建议 (when the host
 *    derived one) and evidence; bottom buttons call 查缺补漏/生成装配清单/预览/
 *    应用/回滚 and 派单草稿, results shown in place. 一键整理 only reaches the
 *    preview: it writes no packs/<id>.json and never applies on its own.
 *
 * Transport: every request is document-relative (api/guizhi/...), never
 * root-absolute, because the host deploys the GUI under a base path and serves
 * routes at the origin root (docs/host-notes.md §6). The panel writes no files
 * itself: it only calls its own routes; the host half owns the data root.
 *
 * 真机面板验证 not-run（D5）：本文件只用 node --check 校验过语法，没有把插件
 * 装进测试 profile、没有重启 DSH、没有在真实 Web GUI 里渲染过。docs/ui-preview.html
 * 是静态视觉预览（假数据、非真实面板），不能当作真机验证。手动验证步骤：
 *   1) 按 docs/host-notes.md §8 建 guizhi-test profile 并安装本仓库；
 *   2) 打开侧栏「归置」，确认三屏可切换；
 *   3) 点「重新扫描」，整理页数字应变化；用量未知时用量列显示「未知」；
 *   4) 浏览器 Network 面板确认 api/guizhi/state 每 3 秒返回 200。
 *
 * Failure policy: a shell without the slots seats logs a warning and leaves the
 * GUI untouched; a failed fetch only renders an error banner/line, never throws
 * into the shell. An external plugin must never take the whole GUI boot down.
 *
 * @module @fanyingnie/dsh-guizhi/client
 */
(function () {
  'use strict'

  /** The row id, shared with the main slot key. */
  var PANEL_ID = 'guizhi'
  var SLOT_PANEL_LIST = 'sidebar.panellist'
  var SLOT_MAIN = 'main'
  /**
   * Row order among the shell's global panel rows. The shell's own rows use
   * Plugins 0 / Schedule 10 / skill center 30, so 20 slots 归置 right after
   * Schedule and before the skill center: early enough in a long panel list to
   * become the product's memory hook, without pushing the shell's primary rows
   * (Plugins) down. Keep this a single small number; the shell sorts ascending.
   */
  var PANEL_ORDER = 20
  /** The only version constant in the browser half. */
  var PLUGIN_VERSION = '0.1.0'
  var STYLE_MARKER = 'data-guizhi-style'
  /** Document-relative API prefix (never root-absolute; see module header). */
  var API_BASE = 'api/guizhi/'
  /** State poll interval: the design asks for every 2-5 seconds. */
  var POLL_MS = 3000
  /** Client root context captured at mount; only used by explicit user clicks. */
  var panelContext = null
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
    { id: 'clean', title: '整理' },
    { id: 'scenarios', title: '场景' },
    { id: 'map', title: '工作流' },
  ]

  /** One inline icon per scenario chip (stroke SVGs, no external assets). */
  var SCENARIO_ICONS = {
    content: 'pen',
    design: 'palette',
    dev: 'code',
    research: 'search',
    office: 'briefcase',
    daily: 'sun',
  }

  /**
   * One-click catalog presets. A chip only fills the URL input — it never saves
   * and never requests the source; the user still has to press 「保存」. Keep in
   * sync with the README 「推荐源」 table (guarded by test/client-sync.test.js).
   */
  var SOURCE_PRESETS = [
    {
      id: 'dshopen',
      label: 'dshopen 开放市场',
      url: 'https://dshopen.org/index.json',
      note: '社区索引 · 实测约 3s、缓存约 0.6MB（在 1MB 缓存上限内）',
    },
    {
      id: 'jsdelivr',
      label: 'jsDelivr 精选索引',
      url: 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json',
      note: '索引较大 · 实测约 7s、缓存约 3.2MB，超过 1MB 缓存上限，会每次重新拉取',
    },
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
    origin: '来源类型',
    overlap: '重叠说明',
    installSource: '安装方式',
    pluginVersion: '插件版本',
    toolUsed30d: '工具近 30 天用量',
  }

  /** Known `origin` values rendered in Chinese; anything else stays raw. */
  var ORIGIN_LABELS = { bundled: '内置（bundled）', custom: '自定义（custom）' }

  var STATUS_LABELS = { have: '已有', missing: '缺', redundant: '冗余' }

  /** Proposal kind chips in the unified result card. */
  var KIND_LABELS = { pack: '装配清单', install: '安装', skill: '技能', plugin: '插件' }

  /** Inline stroke-icon shapes, [tag, props] tuples shared by every icon() call. */
  var ICON_SHAPES = {
    stow: [
      ['path', { d: 'M12 3.4v8.1' }],
      ['path', { d: 'M8.7 8.4 12 11.7l3.3-3.3' }],
      ['path', { d: 'M4 14h16' }],
      ['path', { d: 'M5 14v3.3c0 1.4 1.1 2.5 2.5 2.5h9c1.4 0 2.5-1.1 2.5-2.5V14' }],
      ['path', { d: 'M9.4 17.7h5.2' }],
    ],
    layers: [
      ['path', { d: 'M12 3.6 20 8l-8 4.4L4 8l8-4.4Z' }],
      ['path', { d: 'M4 12.2 12 16.6l8-4.4' }],
      ['path', { d: 'M4 16.2 12 20.6l8-4.4' }],
    ],
    grid: [
      ['rect', { x: 3.5, y: 3.5, width: 7, height: 7, rx: 1.6 }],
      ['rect', { x: 13.5, y: 3.5, width: 7, height: 7, rx: 1.6 }],
      ['rect', { x: 3.5, y: 13.5, width: 7, height: 7, rx: 1.6 }],
      ['rect', { x: 13.5, y: 13.5, width: 7, height: 7, rx: 1.6 }],
    ],
    wrench: [
      ['path', { d: 'M14.6 6.4a3.6 3.6 0 0 0-4.7 4.5L4 16.8 7.2 20l5.9-5.9a3.6 3.6 0 0 0 4.5-4.7l-2.2 2.2-2.4-.6-.6-2.4 2.2-2.2Z' }],
    ],
    sparkles: [
      ['path', { d: 'M11 3.8 12.6 7.6 16.4 9.2 12.6 10.8 11 14.6 9.4 10.8 5.6 9.2 9.4 7.6 11 3.8Z' }],
      ['path', { d: 'M17.4 13.6 18.3 15.7 20.4 16.6 18.3 17.5 17.4 19.6 16.5 17.5 14.4 16.6 16.5 15.7 17.4 13.6Z' }],
    ],
    clock: [
      ['circle', { cx: 12, cy: 12, r: 8 }],
      ['path', { d: 'M12 7.4V12l3.1 2' }],
    ],
    refresh: [
      ['path', { d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3' }],
      ['path', { d: 'M20 4.4v4.8h-4.8' }],
    ],
    check: [['path', { d: 'M4.8 12.4 9 16.6 19.2 6.4' }]],
    alert: [
      ['path', { d: 'M12 4.4 20.4 19.2H3.6L12 4.4Z' }],
      ['path', { d: 'M12 9.8v4.2' }],
      ['circle', { cx: 12, cy: 16.7, r: 0.8, fill: 'currentColor', stroke: 'none' }],
    ],
    info: [
      ['circle', { cx: 12, cy: 12, r: 8.2 }],
      ['path', { d: 'M12 11v5.2' }],
      ['circle', { cx: 12, cy: 7.8, r: 0.8, fill: 'currentColor', stroke: 'none' }],
    ],
    chevron: [['path', { d: 'M7.6 9.8 12 14.2l4.4-4.4' }]],
    pen: [
      ['path', { d: 'M4 20.2h4L19.4 8.8l-4.2-4.2L4 16.2v4Z' }],
      ['path', { d: 'M13.4 6.4l4.2 4.2' }],
    ],
    palette: [
      ['path', { d: 'M12 3.2a8.8 8.8 0 0 0 0 17.6h1.4a2.4 2.4 0 0 0 1.1-4.5 1.9 1.9 0 0 1 1-3.6h1.9a3 3 0 0 0 3-3A8.8 8.8 0 0 0 12 3.2Z' }],
      ['circle', { cx: 8.2, cy: 10.2, r: 0.9, fill: 'currentColor', stroke: 'none' }],
      ['circle', { cx: 12.2, cy: 7.8, r: 0.9, fill: 'currentColor', stroke: 'none' }],
      ['circle', { cx: 15.8, cy: 10.4, r: 0.9, fill: 'currentColor', stroke: 'none' }],
    ],
    code: [
      ['path', { d: 'M9 7.4 4.4 12 9 16.6' }],
      ['path', { d: 'M15 7.4 19.6 12 15 16.6' }],
    ],
    search: [
      ['circle', { cx: 11, cy: 11, r: 6.4 }],
      ['path', { d: 'M15.8 15.8 20 20' }],
    ],
    briefcase: [
      ['rect', { x: 3.6, y: 7.2, width: 16.8, height: 11.8, rx: 2 }],
      ['path', { d: 'M9 7.2V5.6A1.6 1.6 0 0 1 10.6 4h2.8A1.6 1.6 0 0 1 15 5.6v1.6' }],
      ['path', { d: 'M3.6 12.4h16.8' }],
    ],
    sun: [
      ['circle', { cx: 12, cy: 12, r: 4 }],
      ['path', { d: 'M12 2.6v2.2M12 19.2v2.2M4.4 12H2.2M21.8 12h-2.2M5.8 5.8l1.6 1.6M16.6 16.6l1.6 1.6M18.2 5.8l-1.6 1.6M7.4 16.6l-1.6 1.6' }],
    ],
    box: [
      ['path', { d: 'M12 3.4 20 7.8v8.4L12 20.6 4 16.2V7.8l8-4.4Z' }],
      ['path', { d: 'M4 7.8 12 12.2l8-4.4M12 12.2v8.4' }],
    ],
    dot: [['circle', { cx: 12, cy: 12, r: 3.2, fill: 'currentColor', stroke: 'none' }]],
  }

  /** Inject the panel stylesheet once, tagged so re-apply never stacks sheets. */
  function ensureStyle() {
    if (typeof document === 'undefined' || !document.head) return
    if (document.querySelector('style[' + STYLE_MARKER + ']') !== null) return
    var style = document.createElement('style')
    style.setAttribute(STYLE_MARKER, '')
    style.textContent = [
      '.gz-root{--gz-fb-bg:#ffffff;--gz-fb-card:#f7f8fa;--gz-fb-text:#1f2328;--gz-fb-text-2:#59606b;--gz-fb-text-3:#8b919c;--gz-fb-border:rgba(31,35,40,.16);--gz-fb-border-soft:rgba(31,35,40,.09);--gz-fb-hover:rgba(31,35,40,.055);--gz-fb-accent:#2563eb;--gz-fb-accent-ink:#ffffff;--gz-fb-focus:#2563eb;--gz-fb-mono:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;--gz-fb-ok:#15803d;--gz-fb-warn:#b45309;--gz-fb-danger:#b91c1c;--gz-bg:var(--dsw-alias-bg-base,var(--gz-fb-bg));--gz-card-bg:var(--gz-fb-card);--gz-text:var(--dsw-alias-label-primary,var(--gz-fb-text));--gz-text-2:var(--dsw-alias-label-secondary,var(--gz-fb-text-2));--gz-text-3:var(--dsw-alias-label-tertiary,var(--gz-fb-text-3));--gz-border:var(--dsw-alias-border-l2,var(--gz-fb-border));--gz-border-soft:var(--dsw-alias-border-l3,var(--gz-fb-border-soft));--gz-hover:var(--dsw-alias-interactive-bg-hover,var(--gz-fb-hover));--gz-tint:var(--gz-fb-hover);--gz-accent:var(--dsw-alias-state-business-primary,var(--gz-fb-accent));--gz-accent-ink:var(--dsw-alias-label-primary-inverted,var(--gz-fb-accent-ink));--gz-focus:var(--dsw-focus-ring-color,var(--gz-fb-focus));--gz-focus-w:var(--dsw-focus-ring-width,2px);--gz-radius-sm:var(--dsw-radius-sm,8px);--gz-radius-md:var(--dsw-radius-md,12px);--gz-mono:var(--ds-font-family-code,var(--gz-fb-mono));--gz-ease:var(--ds-ease-in-out,cubic-bezier(.2,.7,.3,1));--gz-ok:var(--gz-fb-ok);--gz-warn:var(--gz-fb-warn);--gz-danger:var(--gz-fb-danger);display:flex;flex-direction:column;box-sizing:border-box;height:100%;min-width:264px;padding:20px 22px 0;color:var(--gz-text);background:var(--gz-bg);overflow:auto;font:13px/1.5 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);container-type:inline-size;container-name:gz;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,var(--gz-fb-border-soft)) transparent}',
      '@media (prefers-color-scheme:dark){.gz-root{--gz-fb-bg:#101216;--gz-fb-card:#171a21;--gz-fb-text:#e8eaed;--gz-fb-text-2:#a7aeb9;--gz-fb-text-3:#7f8794;--gz-fb-border:rgba(232,234,237,.18);--gz-fb-border-soft:rgba(232,234,237,.1);--gz-fb-hover:rgba(232,234,237,.07);--gz-fb-accent:#60a5fa;--gz-fb-accent-ink:#0b1220;--gz-fb-focus:#60a5fa;--gz-fb-ok:#4ade80;--gz-fb-warn:#fbbf24;--gz-fb-danger:#f87171}}',
      '.gz-root *{box-sizing:border-box}',
      '.gz-root ::selection{background:var(--gz-tint)}',
      '.gz-root .gz-ico{display:block;flex:0 0 auto}',
      '.gz-head{display:flex;flex-direction:column;gap:7px;padding-bottom:14px;border-bottom:1px solid var(--gz-border-soft);flex:0 0 auto}',
      '.gz-brandbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.gz-brand{display:flex;align-items:center;gap:10px;min-width:0}',
      '.gz-brand-mark{display:inline-flex;align-items:center;justify-content:center;width:33px;height:33px;border-radius:10px;background:var(--gz-accent);color:var(--gz-accent-ink);flex:0 0 auto;box-shadow:0 1px 2px rgba(0,0,0,.14)}',
      '.gz-brand-mark .gz-ico{width:18px;height:18px}',
      '.gz-brand-text{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}',
      '.gz-title{margin:0;font-size:20px;line-height:1.2;font-weight:650;letter-spacing:.03em;color:var(--gz-text)}',
      '.gz-wordmark{font-size:10px;line-height:1.6;letter-spacing:.16em;text-transform:uppercase;color:var(--gz-text-3);border:1px solid var(--gz-border-soft);border-radius:999px;padding:0 7px}',
      '.gz-head-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}',
      '.gz-sys{display:inline-flex;align-items:center;gap:6px;font-size:11px;line-height:1.6;color:var(--gz-text-2);padding:2px 9px 2px 8px;border:1px solid var(--gz-border-soft);border-radius:999px;background:var(--gz-card-bg);white-space:nowrap}',
      '.gz-sys-dot{width:7px;height:7px;border-radius:50%;background:var(--gz-text-3);flex:0 0 auto;transition:background-color 140ms var(--gz-ease)}',
      '.gz-sys-ready .gz-sys-dot{background:var(--gz-ok);box-shadow:0 0 0 3px rgba(22,163,74,.14)}',
      '.gz-sys-loading .gz-sys-dot{background:var(--gz-warn);box-shadow:0 0 0 3px rgba(217,119,6,.14);animation:gz-pulse 1.3s ease-in-out infinite}',
      '.gz-sys-error .gz-sys-dot{background:var(--gz-danger);box-shadow:0 0 0 3px rgba(220,38,38,.14)}',
      '.gz-sub{margin:0;font-size:12px;line-height:1.55;color:var(--gz-text-2);max-width:62ch}',
      '.gz-sub-note{color:var(--gz-text-3)}',
      '.gz-navrow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:12px;flex-wrap:wrap}',
      '.gz-tabs{position:relative;display:flex;align-items:stretch;gap:2px;padding:3px;border:1px solid var(--gz-border-soft);border-radius:12px;background:var(--gz-card-bg);flex:0 1 auto;min-width:0}',
      '.gz-tab{position:relative;z-index:1;flex:1 1 auto;min-width:58px;border:0;background:transparent;color:var(--gz-text-2);font:inherit;font-size:12.5px;font-weight:500;line-height:1.4;padding:6px 15px;border-radius:9px;cursor:pointer;transition:color 140ms var(--gz-ease)}',
      '.gz-tab:hover{color:var(--gz-text)}',
      '.gz-tab:focus-visible{outline:var(--gz-focus-w) solid var(--gz-focus);outline-offset:2px}',
      '.gz-tab-on{color:var(--gz-text);font-weight:650}',
      '.gz-tab-ind{position:absolute;z-index:0;top:3px;bottom:3px;left:3px;width:calc((100% - 6px)/3);border-radius:9px;background:var(--gz-bg);border:1px solid var(--gz-border-soft);box-shadow:0 1px 2px rgba(0,0,0,.08);transition:transform 160ms var(--gz-ease)}',
      '.gz-badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.gz-badge{display:inline-flex;align-items:baseline;gap:5px;font-size:10.5px;line-height:1.7;color:var(--gz-text-2);background:var(--gz-card-bg);border:1px solid var(--gz-border-soft);border-radius:999px;padding:0 9px;white-space:nowrap}',
      '.gz-badge-num{font-size:12px;font-weight:650;color:var(--gz-text);font-variant-numeric:tabular-nums}',
      '.gz-body{display:flex;flex-direction:column;gap:14px;flex:1 0 auto;min-height:0;padding:16px 0 6px}',
      '.gz-panel{display:flex;flex-direction:column;gap:14px;outline:none;animation:gz-fade 150ms var(--gz-ease)}',
      '.gz-section{display:flex;flex-direction:column;gap:12px}',
      '.gz-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.gz-section-title{margin:0;font-size:14px;font-weight:650;letter-spacing:.01em;color:var(--gz-text)}',
      '.gz-meta{font-size:11px;color:var(--gz-text-3);font-variant-numeric:tabular-nums}',
      '.gz-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}',
      '.gz-card{position:relative;display:flex;flex-direction:column;gap:5px;border:1px solid var(--gz-border-soft);border-radius:var(--gz-radius-md);padding:12px 13px 11px;background:var(--gz-card-bg);overflow:hidden;transition:border-color 140ms var(--gz-ease),background-color 140ms var(--gz-ease)}',
      '.gz-card::before{content:"";position:absolute;top:0;bottom:0;left:0;width:3px;background:var(--gz-accent);opacity:.7}',
      '.gz-card:hover{border-color:var(--gz-border)}',
      '.gz-card-top{display:flex;align-items:center;gap:6px;color:var(--gz-text-2);min-width:0}',
      '.gz-card-icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:var(--gz-tint);color:var(--gz-accent);flex:0 0 auto}',
      '.gz-card-label{font-size:11px;font-weight:500;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.gz-card-num{font-size:26px;line-height:1.05;font-weight:660;letter-spacing:-.01em;color:var(--gz-text);font-variant-numeric:tabular-nums}',
      '.gz-card-hint{font-size:10px;line-height:1.45;color:var(--gz-text-3)}',
      '.gz-card[data-tone=warn]::before{background:var(--gz-warn)}',
      '.gz-card[data-tone=warn] .gz-card-icon{background:rgba(217,119,6,.13);color:var(--gz-warn)}',
      '.gz-card[data-tone=warn] .gz-card-num{color:var(--gz-warn)}',
      '.gz-note{display:flex;align-items:flex-start;gap:8px;font-size:11px;line-height:1.55;color:var(--gz-text-2);background:var(--gz-tint);border:1px solid var(--gz-border-soft);border-radius:var(--gz-radius-sm);padding:7px 10px}',
      '.gz-note .gz-ico{margin-top:1px;color:var(--gz-warn)}',
      '.gz-details{border:1px solid var(--gz-border-soft);border-radius:var(--gz-radius-sm);background:var(--gz-card-bg);padding:0 11px}',
      '.gz-details[open]{padding-bottom:8px}',
      '.gz-details>summary{display:flex;align-items:center;gap:6px;cursor:pointer;list-style:none;padding:8px 0;font-size:11px;line-height:1.4;color:var(--gz-text-2)}',
      '.gz-details>summary::-webkit-details-marker{display:none}',
      '.gz-details>summary .gz-ico{color:var(--gz-text-3);transition:transform 140ms var(--gz-ease)}',
      '.gz-details[open]>summary .gz-ico{transform:rotate(180deg)}',
      '.gz-details>summary:focus-visible{outline:var(--gz-focus-w) solid var(--gz-focus);outline-offset:2px;border-radius:4px}',
      '.gz-warn-list{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:3px;font-size:11px;line-height:1.5;color:var(--gz-warn)}',
      '.gz-warn-list li{word-break:break-word}',
      '.gz-table-card{border:1px solid var(--gz-border-soft);border-radius:var(--gz-radius-md);overflow:hidden;background:var(--gz-card-bg)}',
      '.gz-table-scroll{max-height:52vh;overflow:auto;overscroll-behavior:contain}',
      '.gz-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px}',
      '.gz-table th{position:sticky;top:0;z-index:1;text-align:left;font-size:10.5px;font-weight:600;letter-spacing:.04em;color:var(--gz-text-3);background:var(--gz-card-bg);padding:9px 12px;border-bottom:1px solid var(--gz-border-soft);white-space:nowrap}',
      '.gz-table td{padding:8px 12px;border-bottom:1px solid var(--gz-border-soft);vertical-align:middle}',
      '.gz-table tbody tr{transition:background-color 120ms var(--gz-ease)}',
      '.gz-table tbody tr:hover{background:var(--gz-hover)}',
      '.gz-table tbody tr:last-child td{border-bottom:none}',
      '.gz-tool-name{font-family:var(--gz-mono);font-size:12px;white-space:nowrap;color:var(--gz-text)}',
      '.gz-owners{display:inline-flex;flex-wrap:wrap;gap:4px;max-width:100%}',
      '.gz-owner-chip{display:inline-block;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:1.8;padding:0 7px;border-radius:999px;border:1px solid var(--gz-border-soft);background:var(--gz-bg);color:var(--gz-text-2)}',
      '.gz-owner-none{color:var(--gz-text-3)}',
      '.gz-usage{display:flex;align-items:center;gap:8px;min-width:108px}',
      '.gz-usage-bar{position:relative;flex:1 1 auto;min-width:38px;height:6px;border-radius:999px;background:var(--gz-tint);overflow:hidden}',
      '.gz-usage-fill{display:block;height:100%;border-radius:999px;background:var(--gz-accent);opacity:.8;transition:width 180ms var(--gz-ease)}',
      '.gz-usage-num{font-size:12px;color:var(--gz-text-2);font-variant-numeric:tabular-nums;min-width:2ch;text-align:right}',
      '.gz-unknown{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--gz-text-3);background:var(--gz-tint);border:1px solid var(--gz-border-soft);border-radius:999px;padding:0 8px;line-height:1.7;cursor:help;white-space:nowrap}',
      '.gz-empty{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:24px 20px;border:1px dashed var(--gz-border);border-radius:var(--gz-radius-md);background:var(--gz-card-bg);color:var(--gz-text-2);font-size:12.5px}',
      '.gz-empty-icon{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px;background:var(--gz-tint);color:var(--gz-text-2)}',
      '.gz-empty p{margin:0;max-width:62ch;line-height:1.6}',
      '.gz-empty strong{color:var(--gz-text);font-weight:650}',
      '.gz-skel{display:flex;flex-direction:column;gap:12px}',
      '.gz-skel-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}',
      '.gz-skel-block{border:1px solid var(--gz-border-soft);border-radius:var(--gz-radius-md);background:linear-gradient(90deg,var(--gz-card-bg) 25%,var(--gz-hover) 37%,var(--gz-card-bg) 63%);background-size:400% 100%;animation:gz-shimmer 1.4s linear infinite}',
      '.gz-skel-card{height:88px}',
      '.gz-skel-rows{display:flex;flex-direction:column;gap:1px;border:1px solid var(--gz-border-soft);border-radius:var(--gz-radius-md);overflow:hidden;background:var(--gz-card-bg)}',
      '.gz-skel-row{height:35px;margin:1px 12px;border-radius:6px;background:linear-gradient(90deg,var(--gz-card-bg) 25%,var(--gz-hover) 37%,var(--gz-card-bg) 63%);background-size:400% 100%;animation:gz-shimmer 1.4s linear infinite}',
      '.gz-chips{display:flex;flex-wrap:wrap;gap:8px}',
      '.gz-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--gz-border);border-radius:999px;background:var(--gz-bg);color:var(--gz-text-2);font:inherit;font-size:12.5px;line-height:1.4;padding:6px 13px;cursor:pointer;transition:background-color 140ms var(--gz-ease),border-color 140ms,color 140ms,transform 140ms}',
      '.gz-chip:hover{background:var(--gz-hover);color:var(--gz-text)}',
      '.gz-chip:active{transform:scale(.98)}',
      '.gz-chip:focus-visible{outline:var(--gz-focus-w) solid var(--gz-focus);outline-offset:2px}',
      '.gz-chip .gz-chip-check{display:none;color:var(--gz-accent)}',
      '.gz-chip-on{background:var(--gz-tint);border-color:var(--gz-accent);color:var(--gz-accent);font-weight:600;box-shadow:inset 0 0 0 1px var(--gz-accent)}',
      '.gz-chip-on .gz-chip-check{display:inline-flex}',
      '.gz-chip-on .gz-chip-icon{color:var(--gz-accent)}',
      '.gz-chip-icon{display:inline-flex;color:var(--gz-text-3)}',
      '.gz-field{display:flex;flex-direction:column;gap:6px}',
      '.gz-input{width:100%;border:1px solid var(--gz-border);border-radius:var(--gz-radius-sm);background:var(--gz-bg);color:var(--gz-text);font:inherit;font-size:12.5px;line-height:1.55;padding:8px 11px;resize:vertical;transition:border-color 140ms var(--gz-ease),box-shadow 140ms var(--gz-ease)}',
      '.gz-input::placeholder{color:var(--gz-text-3)}',
      '.gz-input:hover{border-color:var(--gz-text-3)}',
      '.gz-input:focus-visible{outline:none;border-color:var(--gz-focus);box-shadow:0 0 0 calc(var(--gz-focus-w) - 1px) var(--gz-focus)}',
      '.gz-input-inline{width:auto;flex:1 1 150px;min-width:110px;max-width:230px;padding:5px 9px;font-size:11.5px}',
      '.gz-counter{display:flex;justify-content:flex-end;gap:8px;font-size:11px;line-height:1.5;color:var(--gz-text-3);font-variant-numeric:tabular-nums}',
      '.gz-counter-warn{color:var(--gz-warn);font-weight:600}',
      '.gz-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.gz-actions-flush{border:0;padding:0}',
      '.gz-saved{font-size:11px;line-height:1.55;color:var(--gz-text-3);word-break:break-word;flex:1 1 200px;min-width:0}',
      '.gz-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--gz-border);border-radius:var(--gz-radius-sm);background:var(--gz-bg);color:var(--gz-text);font:inherit;font-size:12.5px;font-weight:500;line-height:1.2;padding:7px 13px;cursor:pointer;white-space:nowrap;transition:background-color 140ms var(--gz-ease),border-color 140ms,color 140ms,box-shadow 140ms,transform 100ms}',
      '.gz-btn:hover{background:var(--gz-hover)}',
      '.gz-btn:active{transform:translateY(1px)}',
      '.gz-btn:focus-visible{outline:var(--gz-focus-w) solid var(--gz-focus);outline-offset:2px}',
      '.gz-btn:disabled{opacity:.45;cursor:not-allowed;transform:none}',
      '.gz-btn-primary{background:var(--gz-accent);border-color:var(--gz-accent);color:var(--gz-accent-ink);font-weight:600}',
      '.gz-btn-primary:hover{background:var(--gz-accent);filter:brightness(1.07)}',
      '.gz-btn-primary:disabled{filter:none}',
      '.gz-map-meta{margin:0;font-size:11.5px;line-height:1.55;color:var(--gz-text-3);word-break:break-word}',
      '.gz-timeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}',
      '.gz-stage{position:relative;display:flex;gap:12px;padding-bottom:12px}',
      '.gz-stage:last-child{padding-bottom:0}',
      '.gz-stage-marker{position:relative;flex:0 0 auto;width:26px;display:flex;justify-content:center;padding-top:11px}',
      '.gz-stage-marker::before{content:"";position:absolute;top:34px;bottom:-12px;left:50%;width:2px;transform:translateX(-50%);background:var(--gz-border-soft)}',
      '.gz-stage:last-child .gz-stage-marker::before{display:none}',
      '.gz-stage-num{position:relative;z-index:1;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--gz-bg);border:1px solid var(--gz-border);color:var(--gz-text-2);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.gz-stage-body{flex:1 1 auto;min-width:0;border:1px solid var(--gz-border-soft);border-radius:var(--gz-radius-md);background:var(--gz-card-bg);padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
      '.gz-stage-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.gz-stage-title{margin:0;font-size:13.5px;font-weight:650;color:var(--gz-text)}',
      '.gz-stage-id{font-family:var(--gz-mono);font-size:10px;line-height:1.8;color:var(--gz-text-3);background:var(--gz-tint);border-radius:999px;padding:0 7px}',
      '.gz-stage-count{margin-left:auto;font-size:10.5px;color:var(--gz-text-3)}',
      '.gz-stage-empty{margin:0;font-size:11.5px;color:var(--gz-text-3)}',
      '.gz-caps{display:flex;flex-direction:column;gap:6px}',
      '.gz-cap-block{display:flex;flex-direction:column;gap:6px}',
      '.gz-cap{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:1px solid var(--gz-border-soft);border-radius:999px;background:var(--gz-bg);color:var(--gz-text);font:inherit;font-size:12px;line-height:1.4;padding:5px 11px 5px 7px;cursor:pointer;transition:background-color 140ms var(--gz-ease),border-color 140ms,box-shadow 140ms}',
      '.gz-cap:hover{background:var(--gz-hover);border-color:var(--gz-border)}',
      '.gz-cap:focus-visible{outline:var(--gz-focus-w) solid var(--gz-focus);outline-offset:2px}',
      '.gz-cap-icon{display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;border-radius:50%;flex:0 0 auto;background:var(--gz-tint);color:var(--gz-text-2)}',
      '.gz-cap-title{flex:1 1 auto;min-width:0;word-break:break-word}',
      '.gz-cap-status{flex:0 0 auto;font-size:10px;line-height:1.8;font-weight:600;padding:0 8px;border-radius:999px;background:var(--gz-tint);color:var(--gz-text-2);white-space:nowrap}',
      '.gz-cap-status::before{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;margin-right:4px;vertical-align:middle;background:currentColor;opacity:.9}',
      '.gz-cap-chevron{display:inline-flex;color:var(--gz-text-3);transition:transform 140ms var(--gz-ease)}',
      '.gz-cap[aria-expanded=true] .gz-cap-chevron{transform:rotate(180deg)}',
      '.gz-cap-have .gz-cap-icon{background:rgba(22,163,74,.14);color:var(--gz-ok)}',
      '.gz-cap-have .gz-cap-status{background:rgba(22,163,74,.12);color:var(--gz-ok)}',
      '.gz-cap-missing .gz-cap-icon{background:rgba(217,119,6,.15);color:var(--gz-warn)}',
      '.gz-cap-missing .gz-cap-status{background:rgba(217,119,6,.13);color:var(--gz-warn)}',
      '.gz-cap-redundant .gz-cap-icon{background:var(--gz-tint);color:var(--gz-text-3)}',
      '.gz-cap-redundant .gz-cap-title{color:var(--gz-text-2)}',
      '.gz-evidence{margin:0 0 2px 27px;padding:2px 0 2px 12px;border-left:2px solid var(--gz-border-soft);animation:gz-fade 140ms var(--gz-ease)}',
      '.gz-evidence-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(120px,100%),1fr));gap:4px 16px;margin:0}',
      '.gz-evidence-row{display:flex;flex-direction:column;gap:1px;min-width:0;padding:3px 0}',
      '.gz-evidence-key{font-size:10px;line-height:1.5;color:var(--gz-text-3);letter-spacing:.02em}',
      '.gz-evidence-val{font-size:11.5px;line-height:1.5;color:var(--gz-text-2);word-break:break-word}',
      '.gz-evidence-empty{margin:0;font-size:11.5px;color:var(--gz-text-3);padding:2px 0}',
      '.gz-advice{display:flex;flex-direction:column;gap:4px;margin:0 0 8px;padding:8px 10px;border:1px solid var(--gz-border-soft);border-left:3px solid var(--gz-accent);border-radius:var(--gz-radius-sm);background:var(--gz-tint);animation:gz-fade 140ms var(--gz-ease)}',
      '.gz-advice-head{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:650;color:var(--gz-text)}',
      '.gz-advice-icon{display:inline-flex;color:var(--gz-accent)}',
      '.gz-advice-text{margin:0;font-size:11.5px;line-height:1.6;color:var(--gz-text-2);word-break:break-word}',
      '.gz-advice-hint{margin:0;font-size:10.5px;line-height:1.5;color:var(--gz-text-3)}',
      '.gz-actionbar{position:sticky;bottom:-4px;z-index:3;display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--gz-border-soft);border-radius:var(--gz-radius-md);background:var(--gz-bg);box-shadow:0 -8px 20px -14px rgba(0,0,0,.3)}',
      '.gz-actionbar-main{display:flex;flex-wrap:wrap;gap:7px;align-items:center}',
      '.gz-actionbar-snap{display:flex;flex-wrap:wrap;gap:7px;align-items:center;padding-top:8px;border-top:1px dashed var(--gz-border-soft)}',
      '.gz-actionbar-skill{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding-top:8px;border-top:1px dashed var(--gz-border-soft)}',
      '.gz-skill-optin{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;line-height:1.5;color:var(--gz-text-2);cursor:pointer;user-select:none}',
      '.gz-skill-optin input{margin:0;accent-color:var(--gz-accent)}',
      '.gz-snap-label{font-size:10.5px;color:var(--gz-text-3);letter-spacing:.02em;white-space:nowrap}',
      '.gz-result{border:1px solid var(--gz-border-soft);border-radius:var(--gz-radius-md);background:var(--gz-card-bg);padding:12px 14px;display:flex;flex-direction:column;gap:10px;animation:gz-fade 150ms var(--gz-ease)}',
      '.gz-result-head{display:flex;align-items:flex-start;gap:9px}',
      '.gz-result-icon{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--gz-tint);color:var(--gz-text-2)}',
      '.gz-result[data-tone=success] .gz-result-icon{background:rgba(22,163,74,.14);color:var(--gz-ok)}',
      '.gz-result[data-tone=warn] .gz-result-icon{background:rgba(217,119,6,.14);color:var(--gz-warn)}',
      '.gz-result-headings{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.gz-result-kicker{font-size:9.5px;line-height:1.5;letter-spacing:.1em;color:var(--gz-text-3)}',
      '.gz-result-title{margin:0;font-size:12.5px;font-weight:650;line-height:1.45;color:var(--gz-text);word-break:break-word}',
      '.gz-result-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;border-top:1px solid var(--gz-border-soft)}',
      '.gz-result-item{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;padding:7px 0;border-bottom:1px solid var(--gz-border-soft);font-size:12px}',
      '.gz-result-item:last-child{border-bottom:none}',
      '.gz-kind-chip{flex:0 0 auto;font-size:10px;font-weight:600;line-height:1.8;color:var(--gz-text-2);background:var(--gz-tint);border:1px solid var(--gz-border-soft);border-radius:999px;padding:0 7px;white-space:nowrap}',
      '.gz-result-item-title{flex:1 1 auto;min-width:0;word-break:break-word}',
      '.gz-result-effect{font-size:11px;color:var(--gz-text-3);word-break:break-word}',
      '.gz-result-meta{margin:0;font-size:11.5px;line-height:1.55;color:var(--gz-text-2);word-break:break-word}',
      '.gz-sources{display:flex;flex-direction:column;gap:6px;border:1px solid var(--gz-line,rgba(127,127,127,.24));border-radius:var(--gz-radius-md);padding:10px 12px;background:rgba(127,127,127,.04)}',
      '.gz-sources-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.gz-sources-head strong{font-size:12px;font-weight:650;color:var(--gz-text)}',
      '.gz-sources-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.gz-sources-presets{display:flex;flex-direction:column;gap:6px}',
      '.gz-sources-input{flex:1 1 260px;min-width:0}',
      '.gz-progress{display:flex;align-items:center;gap:14px;border:1px solid var(--gz-line,rgba(127,127,127,.24));border-radius:var(--gz-radius-md);padding:12px;background:rgba(127,127,127,.05)}',
      '.gz-progress-ring{position:relative;display:flex;align-items:center;justify-content:center;width:72px;height:72px;flex:0 0 auto}',
      '.gz-progress-ring svg{position:absolute;inset:0}',
      '.gz-ring-track{stroke:rgba(127,127,127,.22)}',
      '.gz-ring-value{stroke:var(--gz-accent,#6c8cff);transition:stroke-dashoffset .4s ease}',
      '.gz-ring-num{position:relative;font-size:15px;font-weight:650;color:var(--gz-text)}',
      '.gz-progress-body{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto}',
      '.gz-progress-title{font-size:12.5px;font-weight:650;color:var(--gz-text)}',
      '.gz-progress-step{margin:0;font-size:11.5px;line-height:1.5;color:var(--gz-text-2);word-break:break-word}',
      '.gz-progress-list{list-style:none;margin:2px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:4px 10px}',
      '.gz-progress-list li{font-size:10.5px;color:var(--gz-text-3)}',
      '.gz-progress-list li[data-state="ok"]{color:#16a34a}',
      '.gz-progress-list li[data-state="warn"]{color:#d97706}',
      '.gz-hash{font-family:var(--gz-mono);font-size:11px;background:var(--gz-tint);border-radius:6px;padding:1px 6px;color:var(--gz-text-2);word-break:break-all}',
      '.gz-result-ok{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--gz-ok)}',
      '.gz-result-err{display:flex;align-items:flex-start;gap:6px;margin:0;font-size:11.5px;line-height:1.5;color:var(--gz-danger);word-break:break-word}',
      '.gz-result-err .gz-ico{margin-top:2px}',
      '.gz-draft{min-height:120px;font-family:var(--gz-mono);font-size:11.5px;line-height:1.55}',
      '.gz-banner{display:flex;align-items:flex-start;gap:9px;border-radius:var(--gz-radius-md);padding:10px 12px;font-size:12px;line-height:1.5;animation:gz-fade 150ms var(--gz-ease)}',
      '.gz-banner .gz-ico{margin-top:2px}',
      '.gz-banner-error{border:1px solid rgba(220,38,38,.4);background:rgba(220,38,38,.08);color:var(--gz-danger)}',
      '.gz-banner-warn{border:1px solid rgba(217,119,6,.32);background:rgba(217,119,6,.07);color:var(--gz-text-2)}',
      '.gz-banner-body{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.gz-banner-body strong{font-size:12px;font-weight:650;color:var(--gz-text)}',
      '.gz-banner-text{min-width:0;word-break:break-word}',
      '.gz-banner-hint{font-size:10.5px;line-height:1.5;color:var(--gz-text-3);flex:0 1 auto}',
      '.gz-status{display:flex;flex-wrap:wrap;align-items:center;gap:10px;min-height:34px;padding:9px 0 11px;margin-top:2px;border-top:1px solid var(--gz-border-soft);font-size:11px;line-height:1.5;color:var(--gz-text-3);flex:0 0 auto}',
      '.gz-status-ok{color:var(--gz-ok);font-weight:600}',
      '.gz-status-warn{color:var(--gz-warn);font-weight:600}',
      '.gz-status-error{color:var(--gz-danger);font-weight:600;word-break:break-word}',
      '.gz-status-ver{margin-left:auto;font-family:var(--gz-mono);font-size:10.5px;color:var(--gz-text-3)}',
      '.gz-hint{font-size:11px;line-height:1.55;color:var(--gz-text-3);word-break:break-word}',
      '@keyframes gz-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '@keyframes gz-fade{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}',
      '@keyframes gz-shimmer{from{background-position:100% 0}to{background-position:-100% 0}}',
      '@container gz (max-width:520px){.gz-cards,.gz-skel-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.gz-card-num{font-size:23px}.gz-tab{padding:6px 11px}.gz-badges{gap:5px}}',
      '@container gz (max-width:340px){.gz-card-hint{display:none}.gz-badge{padding:0 7px}.gz-btn{padding:6px 10px}.gz-actionbar{padding:9px 10px}.gz-snap-label{display:none}.gz-input-inline{max-width:none}.gz-cap{gap:6px;padding:5px 9px 5px 6px}.gz-cap-status{font-size:9.5px;padding:0 6px}.gz-stage-body{padding:10px 11px}.gz-stage-head{gap:6px}.gz-stage-count{display:none}.gz-evidence{margin-left:14px;padding-left:10px}}',
      '@container gz (max-width:440px){.gz-table th,.gz-table td{padding:8px 9px}.gz-card{padding:11px 11px 10px}.gz-title{font-size:19px}.gz-evidence-grid{gap:4px 12px}.gz-owner-chip{max-width:104px}.gz-usage{min-width:84px}.gz-table{font-size:12px}.gz-tool-name{font-size:11.5px}}',
      '@container gz (max-width:330px){.gz-table thead{display:none}.gz-table,.gz-table tbody{display:block}.gz-table tr{display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px;padding:8px 10px;border-bottom:1px solid var(--gz-border-soft)}.gz-table tbody tr:last-child{border-bottom:none}.gz-table tbody tr:hover{background:var(--gz-hover)}.gz-table td{display:block;border:0;padding:0}.gz-table td:nth-child(1){flex:1 1 auto;min-width:0}.gz-table td:nth-child(2){order:3;flex:1 1 100%}.gz-table td:nth-child(3){flex:0 0 auto}.gz-usage-bar{min-width:26px}}',
      '@media (prefers-reduced-motion:reduce){.gz-root,.gz-root *,.gz-root *::before,.gz-root *::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}',
    ].join('\n')
    document.head.appendChild(style)
  }

  /**
   * The left-sidebar panel row icon (the product's memory hook). One-color
   * currentColor stroke so the shell tints it exactly like its own rows; the
   * same mark is the 64x64 brand graphic in icon.svg and the panel brand mark.
   * The hover tooltip comes from the slot label ("归置"), not from the icon, so
   * no title/self-drawn tooltip is attached here.
   * @param {*} React
   * @returns {Function} React component
   */
  function createIcon(React) {
    return function GuizhiIcon() {
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 18,
          height: 18,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          role: 'img',
          'aria-label': '归置',
          focusable: 'false',
        },
        // 归位：向下的箭头落进收纳盒。
        React.createElement('path', { d: 'M12 3.4v8.1' }),
        React.createElement('path', { d: 'M8.7 8.4 12 11.7l3.3-3.3' }),
        // 收纳盒：开口托盘 + 盒内已归置的一条。
        React.createElement('path', { d: 'M4 14h16' }),
        React.createElement('path', { d: 'M5 14v3.3c0 1.4 1.1 2.5 2.5 2.5h9c1.4 0 2.5-1.1 2.5-2.5V14' }),
        React.createElement('path', { d: 'M9.4 17.7h5.2' }),
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

  /**
   * True when the scan HAS tools but every one has null/undefined usage (the
   * scan could not know). F7: an empty tool list is not "unknown" — there is
   * nothing to show, so the 用量未知 note must not appear.
   */
  function usageUnknown(scan) {
    if (scan === null || typeof scan !== 'object' || !Array.isArray(scan.tools)) return true
    if (scan.tools.length === 0) return false
    for (var index = 0; index < scan.tools.length; index += 1) {
      var tool = scan.tools[index]
      if (tool !== null && typeof tool === 'object' && tool.used30d != null) return false // eslint-disable-line eqeqeq
    }
    return true
  }

  /**
   * Truncate one string by code points (Array.from), so a surrogate pair is
   * never split. F7: identical to lib/scenarios.js truncateCustom, which the
   * map route now reuses on the host half.
   * @param {unknown} value @param {number} max @returns {string}
   */
  function truncateByCodePoints(value, max) {
    var text = value === undefined || value === null ? '' : String(value)
    var chars = Array.from(text)
    return chars.length > max ? chars.slice(0, max).join('') : text
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

  /** Evidence object -> [{label, value}] pairs for the grid (never raw keys only). */
  function evidencePairs(evidence) {
    if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) return []
    var keys = Object.keys(evidence)
    var pairs = []
    for (var index = 0; index < keys.length; index += 1) {
      var key = keys[index]
      var value = evidence[key]
      if (key === 'origin' && typeof value === 'string' && ORIGIN_LABELS[value] !== undefined) value = ORIGIN_LABELS[value]
      pairs.push({ label: EVIDENCE_LABELS[key] || key, value: evidenceValue(value) })
    }
    return pairs
  }

  /**
   * Key shared by the map renderer and GET state's advice view. The host's
   * advice item carries stageId/capabilityId; the panel expands by the same pair.
   */
  function capabilityKey(stageId, capabilityId) {
    return String(stageId) + '::' + String(capabilityId)
  }

  /**
   * GET state advice ({ items }) -> lookup keyed by capabilityKey(). Tolerant of
   * a missing or older host: malformed rows are ignored, so the panel simply
   * shows the evidence grid as before.
   */
  function adviceLookup(advice) {
    var table = {}
    if (advice === null || typeof advice !== 'object' || !Array.isArray(advice.items)) return table
    for (var index = 0; index < advice.items.length; index += 1) {
      var item = advice.items[index]
      if (item === null || typeof item !== 'object') continue
      if (typeof item.stageId !== 'string' || typeof item.capabilityId !== 'string') continue
      if (typeof item.text !== 'string' || item.text === '') continue
      table[capabilityKey(item.stageId, item.capabilityId)] = item
    }
    return table
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

      var sourceHook = useState({ url: '', touched: false })
      var sourceDraft = sourceHook[0]
      var setSourceDraft = sourceHook[1]

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

      var pipelineHook = useState({ status: 'idle', percent: 0, step: null, steps: [] })
      var pipeline = pipelineHook[0]
      var setPipeline = pipelineHook[1]

      var draftHook = useState('')
      var draftText = draftHook[0]
      var setDraftText = draftHook[1]

      /** Opt-in skill install: default false, so apply only exports the pack. */
      var installSkillHook = useState(false)
      var installSkill = installSkillHook[0]
      var setInstallSkill = installSkillHook[1]

      /** The most recently generated pack id; pack-aware drafts reuse it. */
      var lastPackIdHook = useState('')
      var lastPackId = lastPackIdHook[0]
      var setLastPackId = lastPackIdHook[1]

      var snapshotHook = useState('')
      var snapshotId = snapshotHook[0]
      var setSnapshotId = snapshotHook[1]

      var copyHook = useState('')
      var copyHint = copyHook[0]
      var setCopyHint = copyHook[1]

      /** Build one inline stroke icon from ICON_SHAPES. */
      function icon(name, size) {
        var shapes = ICON_SHAPES[name] || ICON_SHAPES.dot
        var children = []
        for (var index = 0; index < shapes.length; index += 1) {
          var shape = shapes[index]
          var props = { key: 'shape-' + index }
          for (var key in shape[1]) {
            if (Object.prototype.hasOwnProperty.call(shape[1], key)) props[key] = shape[1][key]
          }
          children.push(h(shape[0], props))
        }
        return h(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: size || 14,
            height: size || 14,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            focusable: 'false',
            className: 'gz-ico',
          },
          children,
        )
      }

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

      var sourcesDoc = data !== null && data !== undefined && data.sources !== null && typeof data.sources === 'object' ? data.sources : null
      var sourcesKey = sourcesDoc === null ? '' : JSON.stringify(sourcesDoc)

      useEffect(function () {
        if (sourcesDoc === null) return
        if (sourceDraft.touched) return
        setSourceDraft({ url: typeof sourcesDoc.url === 'string' ? sourcesDoc.url : '', touched: false })
      }, [sourcesKey])

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

      /** Catalog source form: save/clear the user-supplied format-1 index URL. */
      function onSourceChange(event) {
        var value = event !== null && event !== undefined && event.target !== null && event.target !== undefined ? event.target.value : ''
        setSourceDraft({ url: truncateByCodePoints(value, 500), touched: true })
      }

      function saveSource(url) {
        runAction('保存目录源', function () {
          return apiRequest('sources', { method: 'POST', body: { url: url } })
        }, function (saved) {
          setSourceDraft({ url: saved !== null && typeof saved === 'object' && typeof saved.url === 'string' ? saved.url : '', touched: false })
        })
      }

      function onSaveSource() {
        saveSource(sourceDraft.url)
      }

      function onClearSource() {
        setSourceDraft({ url: '', touched: true })
        saveSource('')
      }

      /** Fill the URL input from a recommended-source chip; never saves, never requests. */
      function applySourcePreset(preset) {
        setSourceDraft({ url: truncateByCodePoints(preset.url, 500), touched: true })
      }

      function renderSources() {
        var busy = action.busy !== ''
        var draftUrl = typeof sourceDraft.url === 'string' ? sourceDraft.url : ''
        var savedUrl = sourcesDoc !== null && typeof sourcesDoc.url === 'string' ? sourcesDoc.url : ''
        var configured = draftUrl.trim() !== ''
        var dirty = draftUrl !== savedUrl
        return h('div', { className: 'gz-sources' },
          h('div', { className: 'gz-sources-head' },
            h('strong', {}, '目录源'),
            h('span', { className: 'gz-hint' }, '查缺补漏用 · 目录格式见 README「目录源」'),
          ),
          h('div', { className: 'gz-sources-presets' },
            h('span', { className: 'gz-hint' }, '推荐源（第三方 · 非官方）：点一下只填入输入框，不自动保存、不主动联网'),
            h('div', { className: 'gz-chips' }, SOURCE_PRESETS.map(function (preset) {
              return h('button', {
                key: preset.id,
                type: 'button',
                className: 'gz-chip gz-source-preset',
                title: preset.url + ' —— ' + preset.note + '（点一下只填入，不自动保存）',
                onClick: function () {
                  applySourcePreset(preset)
                },
              }, preset.label)
            })),
          ),
          h('div', { className: 'gz-sources-row' },
            h('input', {
              className: 'gz-input gz-sources-input',
              type: 'url',
              inputMode: 'url',
              placeholder: 'https://example.com/catalog.json',
              value: sourceDraft.url,
              onChange: onSourceChange,
              'aria-label': '目录源 URL',
            }),
            h('button', { type: 'button', className: 'gz-btn', disabled: busy, onClick: onSaveSource }, '保存'),
            h('button', { type: 'button', className: 'gz-btn', disabled: busy, onClick: onClearSource }, '清空'),
          ),
          h('p', { className: 'gz-hint' }, dirty
            ? '已填入但未保存：点「保存」后才生效（推荐源只填入，不会自动保存，也不会主动联网）。'
            : configured
              ? '已保存；点「查缺补漏」或「一键整理」会使用该目录（缓存 6 小时，不可达会明确报错）。'
              : '只接受 http(s) 链接；可点上方推荐源快速填入，或粘贴自己的 format-1 目录地址。保存后点「查缺补漏」或「一键整理」。'),
          h('p', { className: 'gz-hint' }, '不内置默认目录源：推荐源只是快捷填入，外部目录只当数据读取，是否信任由你决定。'),
        )
      }

      /** Opt-in: install the workflow skill only when the user ticks the box. */
      function onInstallSkillChange(event) {
        var checked =
          event !== null && event !== undefined && event.target !== null && event.target !== undefined && event.target.checked === true
        setInstallSkill(checked)
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
          return { selected: previous.selected.slice(), custom: truncateByCodePoints(value, CUSTOM_MAX_CHARS), touched: true }
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

      /** One-click chain with live progress: poll the host pipeline status while the POST runs. */
      function onPipeline() {
        if (action.busy !== '') return
        setAction({ busy: '一键整理', message: '', error: '', warnings: [] })
        setPipeline({ status: 'running', percent: 0, step: { id: 'scan', label: '扫描本机' }, steps: [] })
        var pollTimer = setInterval(function () {
          apiRequest('pipelineStatus').then(function (progress) {
            if (progress !== null && typeof progress === 'object' && typeof progress.status === 'string' && progress.status !== 'idle') setPipeline(progress)
          }, function () {})
        }, 350)
        apiRequest('pipeline', { method: 'POST', body: {} }).then(function (payload) {
          clearInterval(pollTimer)
          var pipelineWarnings = payload !== null && typeof payload === 'object' && Array.isArray(payload.warnings) ? payload.warnings : []
          if (payload !== null && typeof payload === 'object' && typeof payload.snapshotId === 'string' && payload.snapshotId !== '') setSnapshotId(payload.snapshotId)
          setPipeline({ status: 'done', percent: 100, step: null, steps: Array.isArray(payload.steps) ? payload.steps : [] })
          setResult({ kind: 'pipeline', payload: payload })
          setAction({ busy: '', message: '一键整理完成（已到预览，未写入文件）', error: '', warnings: pipelineWarnings })
          loadState()
        }, function (error) {
          clearInterval(pollTimer)
          var payload = error !== null && error !== undefined ? error.payload : null
          var warnings = payload !== null && typeof payload === 'object' && Array.isArray(payload.warnings) ? payload.warnings : []
          var details = payload !== null && typeof payload === 'object' && Array.isArray(payload.errors) && payload.errors.length > 0 ? '（' + payload.errors.join('；') + '）' : ''
          setPipeline({ status: 'failed', percent: 100, step: null, steps: [] })
          setAction({ busy: '', message: '', error: errorText(error) + details, warnings: warnings })
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
          setAction({ busy: '', message: '', error: '还没有工作流阶段：先保存工作流（或让会话里的 agent 调 stow_map_save）', warnings: [] })
          return
        }
        var stageIds = []
        for (var index = 0; index < stages.length; index += 1) stageIds.push(stages[index].id)
        runAction('生成装配清单', function () {
          return apiRequest('pack', { method: 'POST', body: { stageIds: stageIds, title: '归置装配清单' } })
        }, function (payload) {
          var generatedPack =
            payload !== null && typeof payload === 'object' && payload.pack !== null && typeof payload.pack === 'object' ? payload.pack : null
          if (generatedPack !== null && typeof generatedPack.id === 'string' && generatedPack.id !== '') setLastPackId(generatedPack.id)
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
          return apiRequest('apply', { method: 'POST', body: { ids: ids, installSkill: installSkill === true } })
        }, function (payload) {
          if (payload !== null && typeof payload === 'object' && typeof payload.snapshotId === 'string' && payload.snapshotId !== '') {
            setSnapshotId(payload.snapshotId)
          }
          setResult({ kind: 'apply', payload: payload, installSkill: installSkill === true })
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
        var body = { kind: 'dispatch' }
        if (lastPackId !== '') body.packId = lastPackId
        var usedPackId = lastPackId
        runAction('生成派单草稿', function () {
          return apiRequest('draft', { method: 'POST', body: body })
        }, function (payload) {
          setDraftText(typeof payload.text === 'string' ? payload.text : '')
          setResult({ kind: 'draft', payload: payload, packId: usedPackId })
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

      /** The polled dispatch view; null when no background dispatch has ever run. */
      function dispatchView() {
        var value = data !== null && data !== undefined ? data.dispatch : null
        return value !== null && typeof value === 'object' ? value : null
      }

      /** HH:MM for one ISO timestamp; '' when unusable. */
      function dispatchClock(value) {
        if (typeof value !== 'string' || value === '') return ''
        var time = Date.parse(value)
        if (Number.isNaN(time)) return ''
        var date = new Date(time)
        function pad(number) { return number < 10 ? '0' + String(number) : String(number) }
        return pad(date.getHours()) + ':' + pad(date.getMinutes())
      }

      /** One readable line for the dispatch state. */
      function dispatchLabel(dispatch) {
        var state = dispatch !== null && typeof dispatch.state === 'string' ? dispatch.state : 'unknown'
        var started = dispatch !== null ? dispatchClock(dispatch.startedAt) : ''
        var finished = dispatch !== null ? dispatchClock(dispatch.finishedAt) : ''
        var error = dispatch !== null && typeof dispatch.error === 'string' && dispatch.error !== '' ? '：' + dispatch.error : ''
        if (state === 'running') return '后台执行中…' + (started === '' ? '' : '（开始于 ' + started + '）')
        if (state === 'done') return '已完成' + (finished === '' ? '' : '（' + finished + '）')
        if (state === 'timeout') return '后台执行超时' + error
        if (state === 'lost') return '后台会话已丢失' + error
        if (state === 'failed') return '派单失败' + error
        return '状态未知' + error
      }

      function onDispatch() {
        runAction('后台派单', function () {
          return apiRequest('dispatch', { method: 'POST', body: { kind: 'map' } })
        }, function (payload) {
          setResult({ kind: 'dispatch', payload: payload })
        })
      }

      /**
       * S3: dispatch one constrained worker for the most recent pack.
       * The host tries to shrink the worker's tool surface; that is experimental
       * and best-effort, so the panel reports toolFaceApplied/warnings instead of
       * assuming the restriction took effect.
       */
      function onDispatchPack() {
        if (lastPackId === '') {
          setAction({ busy: '', message: '', error: '先生成装配清单：派发受限子代理需要最近一次装配清单 id', warnings: [] })
          return
        }
        var packId = lastPackId
        runAction('派发受限子代理', function () {
          return apiRequest('dispatch', { method: 'POST', body: { kind: 'pack', packId: packId } })
        }, function (payload) {
          setResult({ kind: 'dispatchPack', payload: payload, packId: packId })
        })
      }

      /** Open the background Session only when the user explicitly clicks it. */
      function onOpenDispatchSession(sessionId) {
        try {
          if (panelContext === null || panelContext === undefined || typeof panelContext.get !== 'function') return
          var uiWorkspace = panelContext.get('uiWorkspace', false)
          if (uiWorkspace !== undefined && uiWorkspace !== null && typeof uiWorkspace.openSession === 'function') {
            uiWorkspace.openSession(sessionId)
          }
        } catch (error) {
          console.warn('[guizhi] 打开后台会话失败：', error)
        }
      }

      /** Circular progress ring + current work item + per-step list for 一键整理. */
      function renderPipelineProgress() {
        if (pipeline === null || typeof pipeline !== 'object' || pipeline.status === 'idle') return null
        var percent = typeof pipeline.percent === 'number' && isFinite(pipeline.percent) ? Math.max(0, Math.min(100, Math.round(pipeline.percent))) : 0
        var radius = 30
        var circumference = 2 * Math.PI * radius
        var offset = circumference * (1 - percent / 100)
        var state = typeof pipeline.status === 'string' ? pipeline.status : 'running'
        var current = pipeline.step !== null && typeof pipeline.step === 'object' ? pipeline.step : null
        var currentLabel = state === 'done' ? '全部完成' : state === 'failed' ? '执行失败' : current !== null && typeof current.label === 'string' ? current.label : '准备中'
        var stepList = Array.isArray(pipeline.steps) ? pipeline.steps : []
        var body = [
          h('strong', { className: 'gz-progress-title' }, state === 'done' ? '一键整理完成' : state === 'failed' ? '一键整理失败' : '正在' + currentLabel),
        ]
        if (state === 'running') {
          body.push(h('p', { className: 'gz-progress-step' }, '当前：' + currentLabel + (current !== null && typeof current.detail === 'string' && current.detail !== '' ? ' · ' + current.detail : '')))
        } else if (state === 'failed' && typeof pipeline.error === 'string') {
          body.push(h('p', { className: 'gz-progress-step gz-status-error' }, pipeline.error))
        }
        if (stepList.length > 0) {
          body.push(h('ul', { className: 'gz-progress-list' }, stepList.map(function (step, stepIndex) {
            var itemState = step !== null && typeof step === 'object' && typeof step.status === 'string' ? step.status : 'running'
            var label = step !== null && typeof step === 'object' && typeof step.label === 'string' ? step.label : ''
            var mark = itemState === 'ok' ? '✓ ' : itemState === 'warn' ? '! ' : itemState === 'skip' ? '– ' : '… '
            return h('li', { key: 'pipeline-progress-' + stepIndex, 'data-state': itemState }, mark + label)
          })))
        }
        return h('div', { className: 'gz-progress', role: 'status', 'aria-live': 'polite', 'aria-label': '一键整理进度 ' + String(percent) + '%' },
          h('div', { className: 'gz-progress-ring' },
            h('svg', { viewBox: '0 0 72 72', width: 72, height: 72, 'aria-hidden': 'true' },
              h('circle', { className: 'gz-ring-track', cx: 36, cy: 36, r: radius, fill: 'none', strokeWidth: 6 }),
              h('circle', { className: 'gz-ring-value', cx: 36, cy: 36, r: radius, fill: 'none', strokeWidth: 6, strokeLinecap: 'round', strokeDasharray: String(circumference), strokeDashoffset: String(offset), transform: 'rotate(-90 36 36)' }),
            ),
            h('span', { className: 'gz-ring-num' }, String(percent) + '%'),
          ),
          h('div', { className: 'gz-progress-body' }, body),
        )
      }
      /** Dispatch status line + optional 查看后台会话 button (never auto-navigates). */
      function renderDispatchStatus() {
        var dispatch = dispatchView()
        if (dispatch === null) return null
        var children = [h('p', { className: 'gz-result-meta' }, dispatchLabel(dispatch))]
        if (typeof dispatch.sessionId === 'string' && dispatch.sessionId !== '') {
          children.push(h('div', { className: 'gz-actions gz-actions-flush' },
            h('button', { type: 'button', className: 'gz-btn', onClick: function () { onOpenDispatchSession(dispatch.sessionId) } }, '查看后台会话'),
            h('span', { className: 'gz-saved' }, '只在你点击时打开，不自动切换。'),
          ))
        }
        return h('div', { className: 'gz-banner', role: 'status' }, h('div', { className: 'gz-banner-body' }, children))
      }

      /** Warning list shared by the scan summary and the action results. */
      function renderWarnings(warnings) {
        if (!Array.isArray(warnings) || warnings.length === 0) return null
        return h('ul', { className: 'gz-warn-list' }, warnings.map(function (message, index) {
          return h('li', { key: 'warn-' + index }, String(message))
        }))
      }

      /** Collapsible warnings block (details/summary, keyboard accessible). */
      function renderWarningDetails(warnings, label) {
        if (!Array.isArray(warnings) || warnings.length === 0) return null
        return h('details', { className: 'gz-details' },
          h('summary', {}, icon('alert', 12), h('span', {}, (label || '警告') + ' ' + String(warnings.length) + ' 条')),
          renderWarnings(warnings),
        )
      }
      /**
       * Scan warnings are mostly engine internals (attribution file caps, a long
       * unowned-tool list). Show a plain-language summary first and keep the raw
       * lines behind 技术详情 so a user is never asked to read them.
       */
      function renderScanWarnings(warnings) {
        if (!Array.isArray(warnings) || warnings.length === 0) return null
        var limitCount = 0
        var missingCount = 0
        var usageCount = 0
        var otherCount = 0
        for (var index = 0; index < warnings.length; index += 1) {
          var message = String(warnings[index])
          if (message.indexOf('源码扫描超过上限') >= 0) limitCount += 1
          else if (message.indexOf('无法归因到插件') >= 0) missingCount += 1
          else if (message.indexOf('用量') >= 0) usageCount += 1
          else otherCount += 1
        }
        var summaries = []
        if (limitCount > 0) summaries.push('部分插件的工具归属信息不完整（扫描量到上限），不影响插件/工具/技能统计。')
        if (missingCount > 0) summaries.push('有部分工具暂时识别不出来源（多为内置或动态注册工具），不影响统计。')
        if (usageCount > 0) summaries.push('用量统计不完整：未知用量显示为「未知」，不会当成 0。')
        if (otherCount > 0) summaries.push('扫描过程中还有 ' + String(otherCount) + ' 条其它提示（详见技术详情）。')
        return h('div', { className: 'gz-banner gz-banner-warn', role: 'status' },
          h('div', { className: 'gz-banner-body' },
            h('strong', {}, '扫描提示（不影响使用）'),
            h('ul', { className: 'gz-warn-list' }, summaries.map(function (text, summaryIndex) {
              return h('li', { key: 'scan-summary-' + summaryIndex }, text)
            })),
            h('details', { className: 'gz-details' },
              h('summary', {}, '技术详情（' + String(warnings.length) + ' 条，供排障）'),
              renderWarnings(warnings),
            ),
          ),
        )
      }

      /** Local YYYY-MM-DD HH:MM for one ISO timestamp; '' when unusable. */
      function formatTimestamp(value) {
        if (typeof value !== 'string' || value === '') return ''
        var time = Date.parse(value)
        if (Number.isNaN(time)) return ''
        var date = new Date(time)
        function pad(number) { return number < 10 ? '0' + String(number) : String(number) }
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
      }

      /** State-level read warnings (e.g. a corrupt scan.json) are never hidden. */
      function renderStateWarnings() {
        if (data === null || !Array.isArray(data.warnings) || data.warnings.length === 0) return null
        return h('div', { className: 'gz-banner gz-banner-warn', role: 'status' },
          icon('alert', 15),
          h('div', { className: 'gz-banner-body' },
            h('strong', {}, '状态读取提示'),
            renderWarnings(data.warnings),
          ),
        )
      }

      function renderStatusBar() {
        var items = []
        if (action.busy !== '') items.push(h('span', { key: 'busy', className: 'gz-hint' }, '正在执行：' + action.busy + '…'))
        if (action.message !== '') items.push(h('span', { key: 'message', className: 'gz-status-ok' }, action.message))
        if (action.error !== '') items.push(h('span', { key: 'action-error', className: 'gz-status-error' }, action.error))
        if (Array.isArray(action.warnings) && action.warnings.length > 0) {
          items.push(h('span', { key: 'action-warnings', className: 'gz-status-warn' }, '警告 ' + action.warnings.length + ' 条（见结果区）'))
        }
        if (view.updatedAt !== null) items.push(h('span', { key: 'updated', className: 'gz-hint' }, '更新于 ' + new Date(view.updatedAt).toLocaleTimeString()))
        if (items.length === 0) items.push(h('span', { key: 'idle', className: 'gz-hint' }, '面板已连接 · 每 3 秒自动刷新'))
        items.push(h('span', { key: 'version', className: 'gz-status-ver' }, 'v' + PLUGIN_VERSION))
        return h('footer', { className: 'gz-status', 'aria-live': 'polite' }, items)
      }

      function renderErrorBanner() {
        if (view.error === null) return null
        return h('div', { className: 'gz-banner gz-banner-error', role: 'alert' },
          icon('alert', 15),
          h('span', { className: 'gz-banner-text' }, '状态读取失败：' + view.error),
          h('span', { className: 'gz-banner-hint' }, '面板会继续每 3 秒重试。'),
        )
      }

      /** Scan totals for header badges; null until the first scan exists. */
      function scanTotals() {
        var scan = data !== null && typeof data === 'object' && data.scan !== null && typeof data.scan === 'object' ? data.scan : null
        if (scan === null) return null
        return scan.totals !== null && typeof scan.totals === 'object' ? scan.totals : {}
      }

      function badgeValue(totals, key) {
        if (totals === null) return '—'
        var value = totals[key]
        return value === null || value === undefined ? '—' : String(value)
      }

      /** Status dot in the brand header: ready / loading / error. */
      function systemStatus() {
        if (view.error !== null) return { tone: 'error', label: '错误' }
        if (view.loading && data === null) return { tone: 'loading', label: '加载中' }
        if (action.busy !== '') return { tone: 'loading', label: '执行中' }
        return { tone: 'ready', label: '就绪' }
      }

      function renderHeader() {
        var status = systemStatus()
        return h('header', { className: 'gz-head' },
          h('div', { className: 'gz-brandbar' },
            h('div', { className: 'gz-brand' },
              h('span', { className: 'gz-brand-mark' }, icon('stow', 18)),
              h('div', { className: 'gz-brand-text' },
                h('h1', { className: 'gz-title' }, '归置'),
                h('span', { className: 'gz-wordmark' }, 'Stow'),
              ),
            ),
            h('div', { className: 'gz-head-actions' },
              h('span', { className: 'gz-sys gz-sys-' + status.tone, title: '系统状态：' + status.label },
                h('span', { className: 'gz-sys-dot' }),
                h('span', { className: 'gz-sys-label' }, status.label),
              ),
              h('button', {
                type: 'button',
                className: 'gz-btn gz-btn-primary',
                disabled: action.busy !== '',
                onClick: onScan,
                title: '重新扫描本机的插件 / 工具 / 技能 / 近 30 天用量（只读）',
              }, icon('refresh', 14), '重新扫描'),
            ),
          ),
          h('p', { className: 'gz-sub' },
            '把本机 DSH 的插件、工具、技能、场景与缺口整理清楚。',
            h('span', { className: 'gz-sub-note' }, ' 只读扫描 + 写本机状态 · 不改 profile · 不代发。'),
          ),
        )
      }

      function renderTabs() {
        var activeIndex = 0
        for (var index = 0; index < TABS.length; index += 1) {
          if (TABS[index].id === tab) activeIndex = index
        }
        var totals = scanTotals()
        var badges = [
          { key: 'plugins', label: '插件' },
          { key: 'tools', label: '工具' },
          { key: 'skills', label: '技能' },
        ]
        return h('div', { className: 'gz-navrow' },
          h('nav', { className: 'gz-tabs', role: 'tablist', 'aria-label': '归置三屏' },
            h('span', { className: 'gz-tab-ind', 'aria-hidden': 'true', style: { transform: 'translateX(' + String(activeIndex * 100) + '%)' } }),
            TABS.map(function (item) {
              var on = tab === item.id
              return h('button', {
                key: item.id,
                type: 'button',
                role: 'tab',
                id: 'gz-tab-' + item.id,
                'aria-selected': on ? 'true' : 'false',
                'aria-controls': 'gz-panel-' + item.id,
                className: 'gz-tab' + (on ? ' gz-tab-on' : ''),
                onClick: function () {
                  setTab(item.id)
                },
              }, item.title)
            }),
          ),
          h('div', { className: 'gz-badges', 'aria-label': '家底汇总' }, badges.map(function (badge) {
            return h('span', { className: 'gz-badge', key: badge.key },
              h('span', {}, badge.label),
              h('span', { className: 'gz-badge-num' }, badgeValue(totals, badge.key)),
            )
          })),
        )
      }

      function panelProps(id) {
        return { className: 'gz-panel', role: 'tabpanel', id: 'gz-panel-' + id, 'aria-labelledby': 'gz-tab-' + id }
      }

      function renderSkeleton() {
        var rows = [0, 1, 2, 3, 4]
        return h('section', panelProps(tab),
          h('div', { className: 'gz-skel', 'aria-hidden': 'true' },
            h('div', { className: 'gz-skel-cards' }, [0, 1, 2, 3].map(function (index) {
              return h('div', { className: 'gz-skel-block gz-skel-card', key: 'skel-card-' + index })
            })),
            h('div', { className: 'gz-skel-rows' }, rows.map(function (index) {
              return h('div', { className: 'gz-skel-row', key: 'skel-row-' + index })
            })),
          ),
          h('p', { className: 'gz-hint' }, '正在读取状态…'),
        )
      }

      function renderClean() {
        var scan = data !== null && typeof data === 'object' && data.scan !== null && typeof data.scan === 'object' ? data.scan : null
        if (scan === null) {
          return h('section', panelProps('clean'),
            h('div', { className: 'gz-section-head' }, h('h2', { className: 'gz-section-title' }, '本机家底')),
            h('div', { className: 'gz-empty' },
              h('span', { className: 'gz-empty-icon' }, icon('layers', 20)),
              h('p', {}, h('strong', {}, '还没有扫描结果。')),
              h('p', {}, '先点右上角「重新扫描」采集本机的插件、工具、技能与近 30 天用量；扫描只读，不改 profile、不调用模型。'),
            ),
          )
        }
        var totals = scan.totals !== null && typeof scan.totals === 'object' ? scan.totals : {}
        var unknown = usageUnknown(scan)
        var cards = [
          { key: 'plugins', label: '插件', value: totals.plugins, icon: 'grid' },
          { key: 'tools', label: '工具', value: totals.tools, icon: 'wrench' },
          { key: 'skills', label: '技能', value: totals.skills, icon: 'sparkles' },
          { key: 'unused', label: '近 30 天未用', value: totals.unusedTools, icon: 'clock', hint: unknown ? '用量未知，只统计已知 0 次' : '已知 0 次调用的工具', tone: 'warn' },
        ]
        var toolRows = Array.isArray(scan.tools) ? scan.tools : []
        var scanWarnings = Array.isArray(scan.warnings) ? scan.warnings : []
        var maxUsage = 0
        for (var index = 0; index < toolRows.length; index += 1) {
          var row = toolRows[index]
          if (row !== null && typeof row === 'object' && row.used30d != null) { // eslint-disable-line eqeqeq
            var numeric = Number(row.used30d)
            if (isFinite(numeric) && numeric > maxUsage) maxUsage = numeric
          }
        }
        return h('section', panelProps('clean'),
          h('div', { className: 'gz-section' },
            h('div', { className: 'gz-section-head' },
              h('h2', { className: 'gz-section-title' }, '本机家底'),
              h('span', { className: 'gz-meta' }, '扫描时间：' + (formatTimestamp(scan.generatedAt) || '未知')),
            ),
            h('div', { className: 'gz-cards' }, cards.map(function (card) {
              var value = card.value === null || card.value === undefined ? '未知' : String(card.value)
              return h('article', { className: 'gz-card', key: card.key, 'data-tone': card.tone || 'accent' },
                h('div', { className: 'gz-card-top' },
                  h('span', { className: 'gz-card-icon' }, icon(card.icon, 13)),
                  h('span', { className: 'gz-card-label' }, card.label),
                ),
                h('span', { className: 'gz-card-num' }, value),
                card.hint !== undefined ? h('span', { className: 'gz-card-hint' }, card.hint) : null,
              )
            })),
            unknown
              ? h('div', { className: 'gz-note' }, icon('alert', 13),
                  h('span', {}, '用量统计不可用：工具表用量列显示「未知」，绝不显示 0。'),
                )
              : null,
            renderScanWarnings(scanWarnings),
            toolRows.length === 0
              ? h('div', { className: 'gz-empty' },
                  h('span', { className: 'gz-empty-icon' }, icon('box', 20)),
                  h('p', {}, h('strong', {}, '扫描结果里没有工具。')),
                  h('p', {}, '宿主 tools 服务可能不可用；可以在会话里运行 stow_probe 进一步排查。'),
                )
              : h('div', { className: 'gz-table-card' },
                  h('div', { className: 'gz-table-scroll' },
                    h('table', { className: 'gz-table' },
                      h('thead', {}, h('tr', {},
                        h('th', {}, '工具'),
                        h('th', {}, '归属（owners）'),
                        h('th', {}, '近 30 天用量'),
                      )),
                      h('tbody', {}, toolRows.map(function (tool, toolIndex) {
                        var valid = tool !== null && typeof tool === 'object'
                        var name = valid && typeof tool.name === 'string' ? tool.name : '(无效行)'
                        var known = valid && tool.used30d != null // eslint-disable-line eqeqeq
                        var usageCell
                        if (!known) {
                          usageCell = h('span', {
                            className: 'gz-unknown',
                            title: '用量未知：宿主未提供近 30 天用量；未知不会显示成 0。',
                          }, '未知')
                        } else {
                          var usageNumber = Number(tool.used30d)
                          var width = 0
                          if (isFinite(usageNumber) && maxUsage > 0) width = Math.max(usageNumber > 0 ? 8 : 0, Math.round((usageNumber / maxUsage) * 100))
                          usageCell = h('div', { className: 'gz-usage' },
                            h('span', { className: 'gz-usage-bar', 'aria-hidden': 'true' },
                              h('span', { className: 'gz-usage-fill', style: { width: String(width) + '%' } }),
                            ),
                            h('span', { className: 'gz-usage-num gz-num' }, String(usageText(valid ? tool : null))),
                          )
                        }
                        return h('tr', { key: 'tool-' + toolIndex },
                          h('td', { className: 'gz-tool-name' }, name),
                          h('td', {}, ownerChips(valid ? tool.owners : null)),
                          h('td', {}, usageCell),
                        )
                      })),
                    ),
                  ),
                ),
            h('p', { className: 'gz-hint' }, '扫描只读采集本机事实；用量未知（used30d = null）显示「未知」而不是 0。'),
          ),
        )
      }

      /** owners -> chips (or an em dash when the scan could not attribute). */
      function ownerChips(owners) {
        if (!Array.isArray(owners) || owners.length === 0) return h('span', { className: 'gz-owner-none' }, '—')
        var chips = []
        for (var index = 0; index < owners.length; index += 1) {
          chips.push(h('span', { className: 'gz-owner-chip', key: 'owner-' + index, title: String(owners[index]) }, String(owners[index])))
        }
        return h('span', { className: 'gz-owners' }, chips)
      }

      function renderScenarios() {
        var selected = scenarioDraft.selected
        var custom = scenarioDraft.custom
        var customLength = Array.from(custom).length
        var counterText = String(customLength) + ' / ' + String(CUSTOM_MAX_CHARS)
        if (customLength >= CUSTOM_MAX_CHARS) counterText += ' · 已到上限'
        else if (customLength >= CUSTOM_MAX_CHARS - 20) counterText += ' · 接近上限'
        var savedText = '还没有保存过场景选择'
        if (selections !== null) {
          var savedSelected = Array.isArray(selections.selected) ? selections.selected : []
          savedText = '已保存：' + (savedSelected.length > 0 ? savedSelected.map(scenarioTitle).join('、') : '无内置场景')
          if (typeof selections.custom === 'string' && selections.custom !== '') savedText += '；自定义：' + selections.custom
        }
        return h('section', panelProps('scenarios'),
          h('div', { className: 'gz-section' },
            h('div', { className: 'gz-section-head' },
              h('h2', { className: 'gz-section-title' }, '选场景'),
              h('span', { className: 'gz-meta' }, '内置 6 个 · 可多选'),
            ),
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
              },
                h('span', { className: 'gz-chip-icon' }, icon(SCENARIO_ICONS[scenario.id] || 'dot', 13)),
                h('span', {}, scenario.title),
                h('span', { className: 'gz-chip-check' }, icon('check', 12)),
              )
            })),
            h('div', { className: 'gz-field' },
              h('textarea', {
                className: 'gz-input',
                rows: 2,
                maxLength: CUSTOM_MAX_CHARS,
                placeholder: '用一句话描述你的场景（200 字以内）',
                value: custom,
                onChange: onCustomChange,
                'aria-label': '自定义场景（一句话，200 字以内）',
              }),
              h('div', { className: 'gz-counter' },
                h('span', { className: customLength >= CUSTOM_MAX_CHARS - 20 ? 'gz-counter-warn' : '' }, counterText),
              ),
            ),
            h('div', { className: 'gz-actions gz-actions-flush' },
              h('button', { type: 'button', className: 'gz-btn gz-btn-primary', disabled: action.busy !== '', onClick: onSaveScenarios }, '保存场景'),
              h('span', { className: 'gz-saved' }, savedText),
            ),
          ),
        )
      }

      /** One unified 「操作结果」card for every action payload. */
      function resultCard(tone, title, children) {
        var iconName = tone === 'success' ? 'check' : tone === 'warn' ? 'alert' : 'info'
        return h('section', { className: 'gz-result', 'data-tone': tone },
          h('div', { className: 'gz-result-head' },
            h('span', { className: 'gz-result-icon' }, icon(iconName, 14)),
            h('div', { className: 'gz-result-headings' },
              h('span', { className: 'gz-result-kicker' }, '操作结果'),
              h('h3', { className: 'gz-result-title' }, title),
            ),
          ),
          children,
        )
      }

      function renderProposalList(items) {
        if (!Array.isArray(items) || items.length === 0) return null
        return h('ul', { className: 'gz-result-list' }, items.map(function (item, index) {
          return h('li', { className: 'gz-result-item', key: 'item-' + index },
            item !== null && typeof item === 'object' && item.kind ? h('span', { className: 'gz-kind-chip' }, KIND_LABELS[item.kind] || String(item.kind)) : null,
            h('span', { className: 'gz-result-item-title' }, String(item !== null && typeof item === 'object' ? item.title || item.id : item)),
            item !== null && typeof item === 'object' && item.effect ? h('span', { className: 'gz-result-effect' }, String(item.effect)) : null,
          )
        }))
      }

      function renderResult() {
        if (result === null || typeof result !== 'object') return null
        var payload = result.payload !== null && typeof result.payload === 'object' ? result.payload : {}
        if (result.kind === 'gaps') {
          var gapItems = Array.isArray(payload.items) ? payload.items : []
          var gapChildren = []
          if (gapItems.length === 0 && !payload.error) gapChildren.push(h('p', { className: 'gz-hint' }, '没有匹配到缺口提案。'))
          gapChildren.push(renderProposalList(gapItems))
          gapChildren.push(renderWarningDetails(payload.warnings, '警告'))
          if (payload.error) {
            gapChildren.push(h('p', { className: 'gz-result-err' }, icon('alert', 13), h('span', {}, '目录错误：' + String(payload.error))))
            if (String(payload.error).indexOf('目录源') >= 0) gapChildren.push(h('p', { className: 'gz-hint' }, '在上方「目录源」填入地址并保存后重试；推荐源与目录格式见 README。'))
          }
          if (payload.stale === true) {
            gapChildren.push(h('p', { className: 'gz-status-warn' }, '目录刷新失败，当前使用过期缓存的结果'))
          }
          return resultCard(payload.error ? 'warn' : 'info', '查缺补漏：' + String(gapItems.length) + ' 条安装提案', gapChildren)
        }
        if (result.kind === 'pack') {
          var pack = payload.pack !== null && typeof payload.pack === 'object' ? payload.pack : {}
          var packWarnCount = Array.isArray(payload.warnings) ? payload.warnings.length : 0
          return resultCard(packWarnCount > 0 ? 'warn' : 'info', '已生成装配清单提案（等待预览/应用）', [
            h('p', { className: 'gz-result-meta' },
              'id ' + String(pack.id || '') +
              '；工具 ' + String(Array.isArray(pack.tools) ? pack.tools.length : 0) + ' 个' +
              '；技能 ' + String(Array.isArray(pack.skills) ? pack.skills.length : 0) + ' 个' +
              '；阶段 ' + String(Array.isArray(pack.stageIds) ? pack.stageIds.length : 0) + ' 个'),
            h('p', { className: 'gz-hint' }, '应用时默认只导出 packs/<id>.json；勾选「应用时安装工作流技能」时会写入 $DSH_HOME/skills/stow-<id>/SKILL.md（frontmatter 默认 disable-model-invocation: true，不进模型技能目录；可回滚）。真机探针：写入 SKILL.md 后当前会话的技能列表没有刷新（skills 总数不变），预计需要新会话 / 重启后才可能可见（未完全验证）。不安装插件、不改 profile，也不限制工具面。'),
            renderWarningDetails(payload.warnings, '警告'),
          ])
        }
        if (result.kind === 'preview') {
          var previewItems = Array.isArray(payload.items) ? payload.items : []
          return resultCard('info', '预览：将应用 ' + String(previewItems.length) + ' 条', [
            h('p', { className: 'gz-result-meta' }, 'hash：', h('code', { className: 'gz-hash' }, String(payload.hash || '').slice(0, 16) + '…')),
            renderProposalList(previewItems),
            h('p', { className: 'gz-hint' }, '点「应用」会按这批条目执行；应用前会先建快照。'),
          ])
        }
        if (result.kind === 'apply') {
          var applied = Array.isArray(payload.applied) ? payload.applied : []
          var installRequested = result.installSkill === true
          var applyChildren = [h('p', { className: 'gz-result-ok' }, icon('check', 13), h('span', {}, '已应用 ' + String(applied.length) + ' 条'))]
          if (typeof payload.snapshotId === 'string' && payload.snapshotId !== '') {
            applyChildren.push(h('p', { className: 'gz-result-meta' }, '快照 id（已填入回滚框）：', h('code', { className: 'gz-hash' }, payload.snapshotId)))
          }
          var installedSkills = Array.isArray(payload.skills) ? payload.skills : []
          if (installedSkills.length > 0) {
            applyChildren.push(h('p', { className: 'gz-result-meta' }, '已安装工作流技能（$DSH_HOME/skills；真机探针：当前会话的技能列表没有刷新，新会话 / 重启后是否可见未完全验证；可回滚）：'))
            applyChildren.push(h('ul', { className: 'gz-result-list' }, installedSkills.map(function (skill, skillIndex) {
              var skillName = skill !== null && typeof skill === 'object' && typeof skill.name === 'string' ? skill.name : String(skill)
              return h('li', { className: 'gz-result-item', key: 'apply-skill-' + skillIndex }, h('span', { className: 'gz-result-item-title' }, skillName))
            })))
          } else if (installRequested) {
            applyChildren.push(h('p', { className: 'gz-result-meta' }, '本次未安装技能（清单为空或技能目录不可用，见警告）。'))
          } else {
            applyChildren.push(h('p', { className: 'gz-result-meta' }, '本次只导出装配清单，未安装技能（勾选「应用时安装工作流技能」可安装）。'))
          }
          applyChildren.push(renderWarningDetails(payload.warnings, '警告'))
          return resultCard('success', '已应用 ' + String(applied.length) + ' 条', applyChildren)
        }
        if (result.kind === 'rollback') {
          return resultCard('success', '已回滚', [
            h('p', { className: 'gz-result-ok' }, icon('check', 13), h('span', {}, '快照已恢复（restored: ' + String(payload.restored === true) + '）')),
          ])
        }
        if (result.kind === 'pipeline') {
          var steps = Array.isArray(payload.steps) ? payload.steps : []
          var previewInfo = payload.preview !== null && typeof payload.preview === 'object' ? payload.preview : {}
          var previewCount = typeof previewInfo.itemCount === 'number' && isFinite(previewInfo.itemCount) ? previewInfo.itemCount : 0
          var previewHash = typeof previewInfo.hash === 'string' ? previewInfo.hash : ''
          var stepRows = steps.map(function (step, stepIndex) {
            var status = step !== null && typeof step === 'object' && typeof step.status === 'string' ? step.status : 'ok'
            var label = step !== null && typeof step === 'object' && typeof step.label === 'string' ? step.label : ''
            var detail = step !== null && typeof step === 'object' && typeof step.detail === 'string' ? step.detail : ''
            return h('li', { key: 'pipeline-step-' + stepIndex, className: status === 'warn' ? 'gz-status-warn' : '' }, label + '：' + detail)
          })
          var pipelineChildren = [h('ul', { className: 'gz-warn-list' }, stepRows)]
          pipelineChildren.push(h('p', { className: 'gz-result-ok' }, icon('check', 13), h('span', {}, '预览完成：' + String(previewCount) + ' 条' + (previewHash === '' ? '' : '（hash ' + previewHash.slice(0, 16) + '…）'))))
          if (typeof payload.snapshotId === 'string' && payload.snapshotId !== '') {
            pipelineChildren.push(h('p', { className: 'gz-result-meta' }, '已建快照：', h('code', { className: 'gz-hash' }, payload.snapshotId)))
          }
          pipelineChildren.push(h('p', { className: 'gz-hint' }, '确认后点「应用」才会写 packs/<id>.json；应用时默认只导出，勾选「应用时安装工作流技能」才会写技能目录（先快照、可回滚）；v1 不安装插件、不改 profile，也不限制工具面。'))
          pipelineChildren.push(renderWarningDetails(payload.warnings, '警告'))
          var hasWarn = (payload.gaps !== null && typeof payload.gaps === 'object' && typeof payload.gaps.error === 'string' && payload.gaps.error !== '') || (Array.isArray(payload.warnings) && payload.warnings.length > 0)
          for (var warnIndex = 0; warnIndex < steps.length; warnIndex += 1) {
            if (steps[warnIndex] !== null && typeof steps[warnIndex] === 'object' && steps[warnIndex].status === 'warn') hasWarn = true
          }
          return resultCard(hasWarn ? 'warn' : 'success', '一键整理完成（已到预览，未写入文件）', pipelineChildren)
        }
        if (result.kind === 'draft') {
          var draftChildren = [
            h('textarea', { className: 'gz-input gz-draft', readOnly: true, value: typeof payload.text === 'string' ? payload.text : draftText, 'aria-label': '派单草稿文本' }),
            h('div', { className: 'gz-actions gz-actions-flush' },
              h('button', { type: 'button', className: 'gz-btn', onClick: onCopyDraft }, '复制到剪贴板'),
              h('span', { className: 'gz-saved' }, copyHint),
            ),
          ]
          if (typeof result.packId === 'string' && result.packId !== '') {
            draftChildren.push(h('p', { className: 'gz-hint' }, '这是按装配清单生成的父→子软约束派单：只使用上述工具 / 技能；工具面未被硬限制（不删工具 schema、不省工具面 token）；真正的工具面硬限制（restrict / preset enforcer）属于 v-next，面板不会代发。'))
          }
          return resultCard('info', '派单草稿（面板不会代发）', draftChildren)
        }
        if (result.kind === 'dispatch') {
          var dispatchPayload = payload.dispatch !== null && typeof payload.dispatch === 'object' ? payload.dispatch : {}
          var startedText = typeof dispatchPayload.startedAt === 'string' ? dispatchClock(dispatchPayload.startedAt) : ''
          return resultCard('info', '已提交后台派单', [
            h('p', { className: 'gz-result-meta' }, '后台会话：' + String(dispatchPayload.sessionId || '') + (startedText === '' ? '' : '；开始于 ' + startedText)),
            h('p', { className: 'gz-hint' }, 'agent 会在后台会话里拆解并调用 stow_map_save；面板每 3 秒轮询，完成后工作流会自动出现。'),
          ])
        }
        if (result.kind === 'dispatchPack') {
          var workerDispatch = payload.dispatch !== null && typeof payload.dispatch === 'object' ? payload.dispatch : {}
          var toolFace = payload.toolFace !== null && typeof payload.toolFace === 'object' ? payload.toolFace : {}
          var requestedTools = Array.isArray(toolFace.requested) ? toolFace.requested : []
          var toolFaceReport = toolFace.report !== null && typeof toolFace.report === 'object' ? toolFace.report : null
          var workerStarted = typeof workerDispatch.startedAt === 'string' ? dispatchClock(workerDispatch.startedAt) : ''
          var dispatchedPackId = typeof result.packId === 'string' && result.packId !== '' ? result.packId : ''
          var dispatchChildren = [
            h('p', { className: 'gz-result-meta' }, 'worker 会话：' + String(workerDispatch.sessionId || '') + (workerStarted === '' ? '' : '；开始于 ' + workerStarted) + (dispatchedPackId === '' ? '' : '；装配清单：' + dispatchedPackId)),
            h('p', { className: 'gz-result-meta' }, '工具面限制调用（toolFaceApplied）：' + (payload.toolFaceApplied === true ? 'true' : 'false') + '；请求限制工具 ' + String(requestedTools.length) + ' 个 —— toolFaceApplied 只说明 restrict 被调用，不代表工具面已按清单收紧；实际可见工具以 report.visible 为准。'),
          ]
          if (toolFaceReport !== null) {
            var visibleTools = Array.isArray(toolFaceReport.visible) ? toolFaceReport.visible : []
            var visibleShown = visibleTools.slice(0, 12)
            var visibleRest = visibleTools.length - visibleShown.length
            var allowedCount = Array.isArray(toolFaceReport.allowed) ? toolFaceReport.allowed.length : 0
            var skippedCount = Array.isArray(toolFaceReport.skipped) ? toolFaceReport.skipped.length : 0
            var leakedCount = Array.isArray(toolFaceReport.leaked) ? toolFaceReport.leaked.length : 0
            dispatchChildren.push(h('p', { className: 'gz-result-meta' }, '实际可见工具（restrict 后）' + String(visibleTools.length) + ' 个' + (visibleShown.length === 0 ? '：' : '：' + visibleShown.join('、') + (visibleRest > 0 ? ' …（其余 ' + String(visibleRest) + ' 个省略）' : ''))))
            dispatchChildren.push(h('p', { className: 'gz-result-meta' }, 'allowed ' + String(allowedCount) + ' / skipped ' + String(skippedCount) + ' / leaked ' + String(leakedCount)))
            dispatchChildren.push(h('p', { className: 'gz-hint' }, '以上是宿主在 worker 创建后回传的实测工具名（真机验收证据），不是「严格 N 个工具」的承诺：run_code、归置自身层与宿主豁免工具仍可能出现在其中，请以这份实测列表为准。'))
            if (typeof toolFaceReport.reason === 'string' && toolFaceReport.reason !== '') {
              dispatchChildren.push(h('p', { className: 'gz-hint' }, '工具面降级原因：' + toolFaceReport.reason))
            }
          } else {
            dispatchChildren.push(h('p', { className: 'gz-hint' }, '本次 1 秒内未取到宿主实测报告（toolFace.report 为空），不伪造可见工具列表；请按下面的 warnings 与 worker 实际工具列表核对。'))
          }
          dispatchChildren.push(h('p', { className: 'gz-hint' }, '实验性、尽力而为：在 agent/created 后对 agent.ctx.tools.restrict({ allow }) 尝试裁剪工具面；run_code 与部分宿主豁免工具可能仍可见，宿主版本不支持或未采用预生成会话 id 时会降级为纯软约束。验收请以宿主实测的 report.visible / worker 实际工具列表为准，不要只看 toolFaceApplied。'))
          dispatchChildren.push(h('p', { className: 'gz-hint' }, '与第 10 个 stow_* 工具 stow_dispatch 同一实现（POST /api/guizhi/dispatch，kind=pack）。'))
          dispatchChildren.push(renderWarningDetails(payload.warnings, '警告'))
          return resultCard(payload.toolFaceApplied === true ? 'info' : 'warn', '已提交受限 worker 派发', dispatchChildren)
        }
        return null
      }

      /**
       * One capability's 精简建议 block. The host's GET state `advice` view is
       * the source of the text (a suggestion written into the map, or a
       * fact-only derived one); the panel neither generates nor executes it.
       */
      function renderCapabilityAdvice(advice) {
        if (advice === null || typeof advice !== 'object') return null
        var title = typeof advice.title === 'string' && advice.title !== '' ? advice.title : '建议'
        var text = typeof advice.text === 'string' ? advice.text : ''
        if (text === '') return null
        var hint = typeof advice.hint === 'string' ? advice.hint : ''
        return h('div', { className: 'gz-advice', role: 'note' },
          h('div', { className: 'gz-advice-head' },
            h('span', { className: 'gz-advice-icon' }, icon('sparkles', 12)),
            h('span', { className: 'gz-advice-title' }, title),
          ),
          h('p', { className: 'gz-advice-text' }, text),
          hint === '' ? null : h('p', { className: 'gz-advice-hint' }, hint),
        )
      }

      function renderMapActions() {
        var busy = action.busy !== ''
        return h('div', { className: 'gz-actionbar', role: 'group', 'aria-label': '工作流操作' },
          h('div', { className: 'gz-actionbar-main' },
            h('button', { type: 'button', className: 'gz-btn gz-btn-primary', disabled: busy, onClick: onPipeline }, '一键整理'),
            h('button', { type: 'button', className: 'gz-btn', disabled: busy, onClick: onGaps }, '查缺补漏'),
            h('button', { type: 'button', className: 'gz-btn', disabled: busy, onClick: onPack }, '生成装配清单'),
            h('button', { type: 'button', className: 'gz-btn', disabled: busy, onClick: onPreview }, '预览变更'),
            h('button', { type: 'button', className: 'gz-btn', disabled: busy, onClick: onApply }, '应用'),
            h('button', { type: 'button', className: 'gz-btn', disabled: busy, onClick: onDraft }, '生成派单草稿'),
            h('button', {
              type: 'button',
              className: 'gz-btn',
              disabled: busy || lastPackId === '',
              onClick: onDispatchPack,
              title: lastPackId === '' ? '先生成装配清单后才能派发受限子代理' : '按最近一次装配清单派发受限 worker（实验性）',
            }, '派发受限子代理'),
          ),
          h('div', { className: 'gz-actionbar-skill' },
            h('label', { className: 'gz-skill-optin', htmlFor: 'gz-install-skill' },
              h('input', {
                id: 'gz-install-skill',
                type: 'checkbox',
                checked: installSkill,
                onChange: onInstallSkillChange,
              }),
              h('span', {}, '应用时安装工作流技能（写入 $DSH_HOME/skills，默认不装，可回滚）'),
            ),
            h('span', { className: 'gz-hint' }, installSkill
              ? '已勾选：应用时会把非空清单安装为 $DSH_HOME/skills/stow-<id>/SKILL.md（可回滚）；真机探针：当前会话未刷新，需要新会话 / 重启后才可能可见（未完全验证）'
              : '未勾选：应用时只导出 packs/<id>.json，不安装技能'),
          ),
          h('div', { className: 'gz-actionbar-snap' },
            h('label', { className: 'gz-snap-label', htmlFor: 'gz-snapshot' }, '快照 id'),
            h('input', {
              id: 'gz-snapshot',
              className: 'gz-input gz-input-inline',
              placeholder: '快照 id（应用后自动填入）',
              value: snapshotId,
              onChange: onSnapshotChange,
              'aria-label': '快照 id',
            }),
            h('button', { type: 'button', className: 'gz-btn', disabled: busy, onClick: onRollback }, '回滚'),
          ),
          h('p', { className: 'gz-hint' }, lastPackId === ''
            ? '「派发受限子代理」需要最近一次装配清单：先点「生成装配清单」，再按该清单派发（与 stow_dispatch 同一实现，共 10 个 stow_* 工具）。'
            : '「派发受限子代理」按最近一次装配清单 ' + lastPackId + ' 派发：实验性、尽力而为，run_code 与部分宿主豁免工具可能仍可见；结果卡会展示宿主实测的 report.visible（restrict 后实际可见工具），验收以它为准。'),
        )
      }

      function renderMap() {
        var map = data !== null && typeof data === 'object' && data.map !== null && typeof data.map === 'object' ? data.map : null
        var stages = map !== null && Array.isArray(map.stages) ? map.stages : []
        var scenarioList = map !== null && Array.isArray(map.scenarios) ? map.scenarios : []
        var adviceByKey = adviceLookup(data !== null && data !== undefined ? data.advice : null)
        var meta = '还没有选场景；可以先在「场景」页选择并保存。'
        if (scenarioList.length > 0) {
          meta = '已选场景：' + scenarioList.map(scenarioTitle).join('、')
          if (typeof map.custom === 'string' && map.custom !== '') meta += '；自定义：' + map.custom
        }
        var body
        if (stages.length === 0) {
          var selectedIds = selections !== null && Array.isArray(selections.selected) ? selections.selected : []
          var dispatch = dispatchView()
          var dispatchRunning = dispatch !== null && dispatch.state === 'running'
          var dispatchSupported = !(data !== null && data !== undefined && data.dispatchSupported === false)
          var hasScenarios = selectedIds.length > 0 || (selections !== null && typeof selections.custom === 'string' && selections.custom.trim() !== '')
          var dispatchDisabled = action.busy !== '' || !dispatchSupported || !hasScenarios || dispatchRunning
          var dispatchHint = ''
          if (!dispatchSupported) dispatchHint = '当前宿主不支持后台派单（缺少后台会话服务）。'
          else if (!hasScenarios) dispatchHint = '先在「场景」页选择场景或填写自定义场景，并保存。'
          else if (dispatchRunning) dispatchHint = '后台执行中…'
          else if (dispatch !== null && (dispatch.state === 'failed' || dispatch.state === 'timeout' || dispatch.state === 'lost')) dispatchHint = '上次没有成功，可以重试。'
          body = h('div', { className: 'gz-empty' },
            h('span', { className: 'gz-empty-icon' }, icon('box', 20)),
            h('p', {}, h('strong', {}, '还没有工作流。')),
            h('p', {}, '点下面按钮让后台 agent 拆解并保存；不需要你新开会话，也不会打断当前对话。'),
            h('div', { className: 'gz-actions' },
              h('button', { type: 'button', className: 'gz-btn gz-btn-primary', disabled: dispatchDisabled, onClick: onDispatch }, dispatchRunning ? '后台执行中…' : (dispatch === null ? '让 Agent 后台拆解' : '重新让 Agent 后台拆解')),
              dispatchHint === '' ? null : h('span', { className: 'gz-saved' }, dispatchHint),
            ),
          )
        } else {
          body = h('ol', { className: 'gz-timeline' }, stages.map(function (stage, stageIndex) {
            var capabilities = stage !== null && typeof stage === 'object' && Array.isArray(stage.capabilities) ? stage.capabilities : []
            return h('li', { className: 'gz-stage', key: 'stage-' + String(stage.id) },
              h('span', { className: 'gz-stage-marker', 'aria-hidden': 'true' },
                h('span', { className: 'gz-stage-num' }, String(stageIndex + 1)),
              ),
              h('div', { className: 'gz-stage-body' },
                h('div', { className: 'gz-stage-head' },
                  h('h3', { className: 'gz-stage-title' }, String(stage.title || stage.id)),
                  h('span', { className: 'gz-stage-id' }, String(stage.id)),
                  h('span', { className: 'gz-stage-count' }, String(capabilities.length) + ' 个能力点'),
                ),
                capabilities.length === 0
                  ? h('p', { className: 'gz-stage-empty' }, '这个阶段还没有能力点')
                  : h('div', { className: 'gz-caps' }, capabilities.map(function (capability, capabilityIndex) {
                      var capId = capability !== null && capability !== undefined && capability.id !== undefined ? String(capability.id) : String(capabilityIndex)
                      var openKey = capabilityKey(stage.id, capId)
                      var open = expandedCap === openKey
                      var advice = adviceByKey[openKey] || null
                      var rawStatus = capability !== null && capability !== undefined ? capability.status : ''
                      var knownStatus = rawStatus === 'have' || rawStatus === 'missing' || rawStatus === 'redundant'
                      var statusText = knownStatus ? statusLabel(rawStatus) : '未标注'
                      var statusIcon = rawStatus === 'have' ? 'check' : rawStatus === 'missing' ? 'alert' : 'dot'
                      var pairs = evidencePairs(capability !== null && capability !== undefined ? capability.evidence : null)
                      return h('div', { className: 'gz-cap-block', key: 'cap-' + capId },
                        h('button', {
                          type: 'button',
                          className: 'gz-cap gz-cap-' + (knownStatus ? rawStatus : 'unknown'),
                          'aria-expanded': open ? 'true' : 'false',
                          onClick: function () {
                            setExpandedCap(open ? '' : openKey)
                          },
                        },
                          h('span', { className: 'gz-cap-icon' }, icon(statusIcon, 12)),
                          h('span', { className: 'gz-cap-title' }, String((capability !== null && capability !== undefined && capability.title) || capId)),
                          h('span', { className: 'gz-cap-status' }, statusText),
                          h('span', { className: 'gz-cap-chevron' }, icon('chevron', 12)),
                        ),
                        open
                          ? h('div', { className: 'gz-evidence' },
                              renderCapabilityAdvice(advice),
                              pairs.length === 0
                                ? h('p', { className: 'gz-evidence-empty' }, '（无证据字段）')
                                : h('dl', { className: 'gz-evidence-grid' }, pairs.map(function (pair, pairIndex) {
                                    return h('div', { className: 'gz-evidence-row', key: 'ev-' + pairIndex },
                                      h('dt', { className: 'gz-evidence-key' }, pair.label),
                                      h('dd', { className: 'gz-evidence-val' }, pair.value),
                                    )
                                  })),
                            )
                          : null,
                      )
                    })),
              ),
            )
          }))
        }
        return h('section', panelProps('map'),
          h('div', { className: 'gz-section' },
            h('div', { className: 'gz-section-head' },
              h('h2', { className: 'gz-section-title' }, '工作流'),
              h('span', { className: 'gz-meta' }, String(stages.length) + ' 个阶段'),
            ),
            h('p', { className: 'gz-map-meta' }, meta),
            body,
            renderSources(),
            renderPipelineProgress(),
            renderDispatchStatus(),
            renderResult(),
            renderMapActions(),
          ),
        )
      }

      function renderBody() {
        if (data === null && view.loading) return renderSkeleton()
        if (tab === 'scenarios') return renderScenarios()
        if (tab === 'map') return renderMap()
        return renderClean()
      }

      return h('div', { className: 'gz-root', 'data-dsh-plugin': 'guizhi' },
        renderHeader(),
        renderTabs(),
        h('div', { className: 'gz-body' }, renderStateWarnings(), renderErrorBanner(), renderBody()),
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
        panelContext = ctx
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
