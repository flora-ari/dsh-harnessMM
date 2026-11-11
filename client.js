/**
 * Browser half of dsh-harnessMM.
 *
 * A DSH plugin may ship a client face beside its host face: the host loads this
 * module through the web ModuleLoader, and it registers one Settings section —
 * the row that appears in the Settings navigation — whose only control is the
 * controller's on/off switch.
 *
 * The switch writes the plugin's own Host configuration: the section reads and
 * writes the "harnessmm" settings namespace through ctx.configForms, the same
 * service the built-in plugin configuration pages use, so flipping it persists
 * exactly like editing policy.enabled by hand.
 */

window.__ModuleLoader__.load({
  id: 'dsh-harnessmm',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace of this package's copy. */
    const NS = 'harnessmm'
    /** Host plugin entry id; also the settings namespace that carries its config. */
    const ENTRY_ID = 'harnessmm'
    /** Settings navigation position: directly after Plugins (15), before agent presets (20). */
    const ORDER = 17
    /** The config path the switch owns. */
    const POLICY_PATH = ['policy', 'enabled']

    const en = {
      nav: 'HarnessMM',
      title: 'HarnessMM',
      intro: 'Guarded decision reuse: the model may declare one frozen action graph, and a native tool call whose receipt guard already holds replaces the next reasoning callback.',
      enable: 'Enable HarnessMM',
      on: 'On',
      off: 'Off',
      onHint: 'The plan section is injected and a declared graph runs without a new model decision.',
      offHint: 'The stock loop runs unchanged; declared graphs are ignored.',
      pending: 'Saving...',
      unavailable: 'This profile serves no editable configuration for HarnessMM.',
      readOnly: 'The configuration is read-only in this profile.',
      failed: 'The host did not accept the change.',
    }
    const zh = {
      nav: 'HarnessMM',
      title: 'HarnessMM',
      intro: '受守卫的决策复用：模型可以声明一张冻结的动作图，回执守卫成立的原生工具调用会代替下一次推理回调。',
      enable: '启用 HarnessMM',
      on: '开',
      off: '关',
      onHint: '会注入计划段落，已声明的动作图无需新的模型决策即可执行。',
      offHint: '回到原生循环，已声明的动作图被忽略。',
      pending: '正在保存…',
      unavailable: '当前 profile 没有为 HarnessMM 提供可编辑的配置。',
      readOnly: '当前 profile 的配置是只读的。',
      failed: '宿主没有接受这次修改。',
    }

    /**
     * Inline-prompt switch: the label sits inside the track, opposite the thumb,
     * on a green (on) or red (off) pill.
     * @param {object} props - on/disabled/labels/change callback.
     */
    function EnableSwitch({ on, disabled, t, busy, onChange }) {
      const track = {
        position: 'relative',
        width: 58,
        height: 30,
        padding: 0,
        border: 'none',
        borderRadius: 15,
        background: on ? '#13ce66' : '#ff4949',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        transition: 'background-color 180ms ease',
        flex: '0 0 auto',
      }
      const thumb = {
        position: 'absolute',
        top: 3,
        left: on ? 31 : 3,
        width: 24,
        height: 24,
        borderRadius: '50%',
        background: '#ffffff',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.28)',
        transition: 'left 180ms ease',
      }
      const prompt = {
        position: 'absolute',
        top: 0,
        left: on ? 11 : 36,
        lineHeight: '30px',
        fontSize: 13,
        fontWeight: 600,
        color: '#ffffff',
        userSelect: 'none',
      }
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on,
        'aria-label': t('enable'),
        'data-harnessmm-switch': on ? 'on' : 'off',
        disabled: disabled === true,
        style: track,
        onClick: () => { void onChange(!on) },
      },
      h('span', { style: prompt, 'aria-hidden': true }, busy ? '…' : on ? 'Y' : 'N'),
      h('span', { style: thumb }))
    }

    /**
     * Write one config path through the shared form. Kept separate from the
     * component so a test can drive it without a renderer.
     * @param {object} form - ctx.configForms entry form.
     * @param {unknown[]} path - config path to set.
     * @param {unknown} value - JSON value.
     * @returns {Promise<boolean>} whether the host accepted the write.
     */
    function writePath(form, path, value) {
      return form.mutate([{ op: 'set', path, value }])
    }

    /** One labelled row: text on the left, control on the right. */
    function Row({ title, hint, control }) {
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 24,
          padding: '14px 0',
          borderBottom: '1px solid rgba(127, 127, 127, 0.18)',
        },
      },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
        h('span', { style: { fontSize: 14, fontWeight: 600 } }, title),
        hint === null ? null : h('span', { style: { fontSize: 12, opacity: 0.72, lineHeight: 1.5 } }, hint)),
      control)
    }

    /**
     * The Settings section body.
     * @param {object} props - locale translator plus the injected form face.
     */
    function HarnessmmSettings({ t, form }) {
      const snapshot = React.useSyncExternalStore(
        (listener) => form.subscribe(listener),
        () => form.getSnapshot(),
      )
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(false)
      const value = snapshot?.value
      const enabled = value?.policy?.enabled === true
      const writable = snapshot?.writable === true && snapshot?.status === 'ready'

      const change = async (next) => {
        setBusy(true)
        setFailure(false)
        try {
          const accepted = await writePath(form, POLICY_PATH, next)
          if (!accepted) setFailure(true)
        } catch {
          setFailure(true)
        } finally {
          setBusy(false)
        }
      }

      let hint = enabled ? t('onHint') : t('offHint')
      if (snapshot?.status === 'unavailable') hint = t('unavailable')
      else if (snapshot?.status === 'ready' && !writable) hint = t('readOnly')
      if (failure) hint = t('failed')

      return h('div', { 'data-harnessmm-settings': 'section' },
        h('h2', { style: { fontSize: 18, fontWeight: 650, margin: '0 0 6px' } }, t('title')),
        h('p', { style: { fontSize: 13, opacity: 0.75, margin: '0 0 18px', lineHeight: 1.6 } }, t('intro')),
        h(Row, {
          title: t('enable'),
          hint,
          control: h(EnableSwitch, {
            on: enabled,
            busy,
            disabled: busy || !writable,
            t,
            onChange: change,
          }),
        }))
    }

    /**
     * Register the settings section.
     * @param {object} ctx - client plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'harnessmm: dictionaries')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: ENTRY_ID,
        order: ORDER,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ form: ctx.configForms.get(ENTRY_ID) }),
      }, HarnessmmSettings))
    }

    exports.name = 'harnessmm'
    exports.inject = ['slots', 'locale', 'configForms']
    exports.apply = apply
    /** Test seam: the pure pieces, without a renderer. */
    exports.__internals = { NS, ENTRY_ID, ORDER, POLICY_PATH, writePath, en, zh }
    return module.exports
  },
})
