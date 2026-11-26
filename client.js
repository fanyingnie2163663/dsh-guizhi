/**
 * Guizhi · browser half.
 *
 * The DSH Web shell loads client plugins as plain scripts through
 * `window.__ModuleLoader__`; the factory receives `require` and must return a
 * cordis plugin descriptor ({ name, inject, apply }). There is no build step in
 * this package: this file is the artifact, plain ES2020 + React.createElement.
 *
 * What it mounts (official slot seats, the same ones the shipped plugin/skill
 * pages use):
 * - a row in the shell's left sidebar list (`sidebar.panellist`);
 * - the page for that row (`main`, keyed by the same id), visible only while
 *   the row is selected.
 *
 * Task 0 scope: title 「归置」 + the version line only. Scans, scenarios and the
 * map screen arrive in later tasks.
 *
 * Failure policy: a shell without the slots seats logs a warning and leaves the
 * GUI untouched; an external plugin must never take the whole GUI boot down.
 *
 * @module @fanyingnie/dsh-guizhi/client
 */
(function () {
  'use strict'

  /** The row id, shared with the `main` slot key. */
  var PANEL_ID = 'guizhi'
  var SLOT_PANEL_LIST = 'sidebar.panellist'
  var SLOT_MAIN = 'main'
  /** Row order among the shell's global panel rows (Plugins 0, Schedule 10, skill center 30). */
  var PANEL_ORDER = 45
  var PLUGIN_VERSION = '0.1.0'
  var STYLE_MARKER = 'data-guizhi-style'

  /** Inject the panel stylesheet once, tagged so re-apply never stacks sheets. */
  function ensureStyle() {
    if (typeof document === 'undefined' || !document.head) return
    if (document.querySelector('style[' + STYLE_MARKER + ']') !== null) return
    var style = document.createElement('style')
    style.setAttribute(STYLE_MARKER, '')
    style.textContent = [
      '.gz-root{display:flex;flex-direction:column;gap:16px;box-sizing:border-box;height:100%;padding:28px 32px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);overflow:auto}',
      '.gz-root *{box-sizing:border-box}',
      '.gz-header{display:flex;flex-direction:column;gap:4px}',
      '.gz-title{margin:0;font-size:22px;line-height:1.25;font-weight:600;letter-spacing:.02em}',
      '.gz-subtitle{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.gz-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:18px 20px;background:var(--dsw-alias-bg-l1);display:flex;flex-direction:column;gap:10px;max-width:640px}',
      '.gz-version{margin:0;font-size:13px;font-weight:600;letter-spacing:.03em}',
      '.gz-hint{margin:0;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}',
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
   * The panel page: Task 0 shows the title and version only.
   * @param {*} React
   * @returns {Function} React component
   */
  function createPage(React) {
    return function GuizhiPage() {
      return React.createElement(
        'div',
        { className: 'gz-root', 'data-dsh-plugin': 'guizhi' },
        React.createElement(
          'header',
          { className: 'gz-header' },
          React.createElement('h1', { className: 'gz-title' }, '归置'),
          React.createElement('p', { className: 'gz-subtitle' }, '按工作流归置你的 DSH 工具箱'),
        ),
        React.createElement(
          'section',
          { className: 'gz-card' },
          React.createElement('p', { className: 'gz-version' }, '版本 ' + PLUGIN_VERSION),
          React.createElement(
            'p',
            { className: 'gz-hint' },
            '脚手架阶段：面板只显示标题与版本号；插件/工具/技能扫描、场景与工作流地图在后续任务接入。',
          ),
        ),
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
