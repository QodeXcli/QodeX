// sample-hello — the smallest useful QodeX mod: a command that opens a pane.
// Disabled by default; it is here to read and copy (`/mods enable sample-hello` to try it).
// It mirrors Claude Code's hello-tabs example, so the same code runs in both.
//
// `/hello-tabs` opens a pane above the prompt with two tabs. The second tab has a button
// that adds one to a counter, and the count is kept in $.store between sessions.
// Keys while the pane has the keyboard: 1 / 2 switch tabs, a adds one, Esc closes it.

// The pane's id, used to open the pane and to recognize it when drawing.
const PANE = 'hello-tabs'

// What the pane shows: which tab is open, and the counter's value.
let tab = 'one'
let count = 0

export function register(on) {
  // Runs before the first prompt, and again after a reload.
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hello-tabs', description: 'Open the hello-tabs pane' })
    const saved = await $.store.get('count')
    if (typeof saved === 'number') count = saved
    return next(e)
  })

  // Runs when you type /hello-tabs: open the pane, give it the keyboard, let Esc close it.
  on('command.run', { command: 'hello-tabs' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Hello tabs', focus: true, closeOnEscape: true })
    return {} // print nothing in the transcript
  })

  // Runs each time QodeX draws a pane.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e) // leave other mods' panes alone
    const { Box, Text, Button } = $.ui.resolve(e)
    const redraw = () => $.ui.invalidate('ui.render')

    const tabButton = (name, label, hotkey) =>
      Button({
        key: 'tab-' + name,
        label,
        hotkey,
        plain: true,
        dimColor: tab !== name,
        onPress: () => {
          tab = name
          redraw()
        },
      })

    const body =
      tab === 'one'
        ? [Text({ children: ['This is the first tab.'] })]
        : [
            Box({
              flexDirection: 'row',
              columnGap: 2,
              children: [
                Button({
                  key: 'more',
                  label: 'Add one (a)',
                  hotkey: 'a',
                  onPress: async () => {
                    count += 1
                    redraw()
                    await $.store.set('count', count)
                  },
                }),
                Text({ children: ['Count: ' + count] }),
              ],
            }),
          ]

    return Box({
      flexDirection: 'column',
      children: [
        Box({ flexDirection: 'row', columnGap: 3, children: [tabButton('one', 'One', '1'), tabButton('two', 'Two', '2')] }),
        Text({ children: [' '] }),
        ...body,
      ],
    })
  })
}

export default register
