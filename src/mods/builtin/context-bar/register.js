// context-bar — a built-in QodeX mod, written against the public mods API only, so it
// doubles as a sample.
//
// `/context-bar` toggles a stacked bar in the band above the prompt: one color per kind
// of context (system prompt, tool definitions, rules, memory, messages, tool results,
// free space), a legend, and "<pct>% of <window>". Whether it shows is kept in $.store,
// so the choice survives a restart. It starts hidden.

// One color per category ($.session.usage().context.byCategory), in drawing order.
const CATEGORIES = [
  { id: 'system', label: 'system', color: 'blue' },
  { id: 'tools', label: 'tools', color: 'magenta' },
  { id: 'rules', label: 'rules', color: 'yellow' },
  { id: 'memory', label: 'memory', color: 'green' },
  { id: 'messages', label: 'messages', color: 'cyan' },
  { id: 'tool-results', label: 'tool results', color: 'red' },
  { id: 'free', label: 'free', color: 'gray' },
]

// Whether the bar shows (loaded from $.store at session.start).
let visible = false

// 1234 → "1.2k", 200000 → "200k".
function compact(n) {
  const fmt = (x) => (x >= 100 ? x.toFixed(0) : x.toFixed(1)).replace(/\.0$/, '')
  if (n >= 1_000_000) return fmt(n / 1_000_000) + 'M'
  if (n >= 1_000) return fmt(n / 1_000) + 'k'
  return String(Math.round(n))
}

// The bar's segments from a usage report: every category with tokens, free space last.
export function segmentsFor(context) {
  const by = new Map((context.byCategory || []).map((c) => [c.category, Math.max(0, Number(c.tokens) || 0)]))
  if (!by.has('free')) {
    let used = 0
    for (const [k, v] of by) if (k !== 'free') used += v
    by.set('free', Math.max(0, context.window - used))
  }
  return CATEGORIES
    .filter((c) => (by.get(c.id) || 0) > 0)
    .map((c) => ({ label: c.label, value: by.get(c.id), color: c.color }))
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-bar',
      description: 'Show or hide the context-window bar above the prompt',
      argumentHint: '[on|off]',
      immediate: true,
    })
    visible = (await $.store.get('visible')) === true
    return next(e)
  })

  on('command.run', { command: 'context-bar' }, async ($, e) => {
    const arg = String(e.args || '').trim().toLowerCase()
    visible = arg === 'on' ? true : arg === 'off' ? false : !visible
    await $.store.set('visible', visible)
    $.ui.invalidate('ui.render')
    return { text: visible ? 'Context bar on — above the prompt. /context-bar again hides it.' : 'Context bar off.' }
  })

  // Keep the numbers current while the bar shows (redraws are throttled for us).
  const refresh = async ($, e, next) => {
    const result = await next(e)
    if (visible) $.ui.invalidate('ui.render')
    return result
  }
  on('turn.complete', refresh)
  on('tool.result', refresh)
  on('session.compact', refresh)

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!visible) return next(e)
    let usage
    try {
      usage = await $.session.usage()
    } catch {
      return next(e)
    }
    const context = usage && usage.context
    if (!context || !(context.window > 0)) return next(e)
    const { Box, Text, Bar } = $.ui.resolve(e)
    const percent = Math.round(Number(context.percent) || (context.tokens / context.window) * 100)
    const tone = percent >= 85 ? 'red' : percent >= 60 ? 'yellow' : 'green'
    const width = typeof e.props.bodyColumns === 'number' ? Math.max(10, Math.min(120, e.props.bodyColumns)) : undefined
    return Box({
      flexDirection: 'column',
      children: [
        Text({
          children: [
            Text({ dimColor: true, children: ['context  '] }),
            Text({ color: tone, bold: true, children: [percent + '%'] }),
            Text({ dimColor: true, children: [' of ' + compact(context.window) + ' · ' + compact(context.tokens) + ' used'] }),
          ],
        }),
        Bar({ segments: segmentsFor(context), total: context.window, showLegend: true, ...(width ? { width } : {}) }),
      ],
    })
  })
}

export default register
