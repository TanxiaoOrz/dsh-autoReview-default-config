/**
 * dsh-auto-review-custom 的**浏览器半区**：设置里的「Auto Review」页。
 *
 * ## 两条数据通道（各用其所）
 *
 * | 数据 | 通道 | 存在哪 |
 * |---|---|---|
 * | 三个开关（默认 auto / 注入提示词 / 文件免审） | `ctx.configForms` | profile 的 `cordis.patch.yml` |
 * | 提示词正文（全局 + 工作区） | `ctx.remote.autoReviewPrompts` | `$DSH_HOME/auto-review/prompts/**` |
 *
 * 开关是结构化短值，进 Config 是宿主的正规做法；提示词是长文本，留在文件里才
 * 能直接编辑、能进 git diff。浏览器没有文件系统，所以文件操作走 Host 的
 * Remote 方法（本文件底部 `TYPERT_REMOTE` 挂载）。
 *
 * ## 为什么全是手写控件
 *
 * 这个构建里**没有**自动表单客户端（官方 `dsh-settings/README.zh.md:39` 亲口承认
 * 「目前没有已发布的客户端这样做」）。宿主只提供表单**数据**，控件全部自己画。
 * 所以这里不能 import `@deepseek-ai/dsh-client-ui-primitives`，样式只用
 * `--dsw-alias-*` 主题 token。
 */

window.__ModuleLoader__.load({
  id: 'dsh-auto-review-custom',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 宿主 Loader 条目 id —— 必须是这个，不是包名。 */
    const ENTRY_ID = 'auto-review-custom'
    /** locale 命名空间。 */
    const LOCALE_NS = 'settings.autoReviewCustom'
    /** Remote 命名空间。 */
    const REMOTE_NAMESPACE = 'autoReviewPrompts'

    /**
     * 惰性挂载的单例 Promise。
     *
     * 必须是**模块级**：同一次页面加载里重复打开设置页只挂一次，避免重复
     * `$mount` 在网关队列里堆积。
     */
    let promptMount = null

    /**
     * ⚠️ 必须与 `lib/typert.js` 的 `TYPERT_REMOTE` 保持一致。
     *
     * 这里内联是因为浏览器半区是普通脚本（只有 `require('react')`），
     * 没法 import 包的 ESM 模块。
     *
     * ## 为什么参数也标 strict
     *
     * `dsh-api-gateway` 的 `requireStrictInputs`（`lib/client.js:2067-2075`）
     * 要求**每个参数**的 `codec.mode === 'strict'`，`src-json` 只能用在 result 上。
     * 但客户端**从不调用** `create`：参数是原样塞进 `args[wire]` 的
     * （`prepareInvocation`，`:1819-1845`）。所以这里给一个最小 stub 就够，
     * 真正的 zod schema 在 Host 侧（`lib/typert.js`）。
     */
    const STRING_CODECS = new Map()

    /** 取（并缓存）某个 endpoint/field 的 strict 字符串码。 */
    function stringCodec(method, index) {
      const key = `${method}:${index}`
      if (!STRING_CODECS.has(key)) {
        STRING_CODECS.set(key, {
          mode: 'strict',
          typeSymbol: `dsh-auto-review-custom#autoReviewPrompts/${method}:parameter:${index}`,
          // 客户端不会调用它；保留一个能自证的实现以防将来被用到。
          create: () => ({
            parse: (value) => {
              if (typeof value !== 'string') throw new Error('expected string')
              return value
            },
            safeParse: (value) =>
              typeof value === 'string'
                ? { success: true, data: value }
                : { success: false, error: new Error('expected string') },
          }),
        })
      }
      return STRING_CODECS.get(key)
    }

    /** 造一个 strict 字符串参数描述符。 */
    function param(method, name, index) {
      return { name, wire: name, source: 'json', codec: stringCodec(method, index) }
    }

    /** 造一条调用描述符。 */
    function descriptor(method, parameterNames) {
      return {
        id: `dsh-auto-review-custom#autoReviewPrompts/${method}`,
        service: 'autoReviewPrompts',
        namespace: 'autoReviewPrompts',
        method,
        invocation: { kind: 'direct' },
        parameters: parameterNames.map((name, index) => param(method, name, index)),
        result: { mode: 'src-json' },
      }
    }

    const TYPERT_REMOTE = {
      package: 'dsh-auto-review-custom',
      descriptors: [
        descriptor('read', []),
        descriptor('writeGlobal', ['text']),
        descriptor('writeWorkspace', ['workspacePath', 'prompt']),
        descriptor('removeWorkspace', ['name']),
        descriptor('listWorkspaces', []),
      ],
    }

    // ── 文案 ────────────────────────────────────────────────────────────
    const en = {
      title: 'Auto Review',
      sectionPermission: 'Permission',
      sectionPrompt: 'Review prompt',
      sectionWorkspace: 'Workspace prompts',
      defaultPresetTitle: 'Enable Auto review by default',
      defaultPresetDescription:
        'New sessions automatically switch to the Auto review permission preset.',
      promptsTitle: 'Inject review prompt',
      promptsDescription:
        'Append your wording to the reviewer request so it understands this project.',
      allowRulesTitle: 'Skip review for workspace file edits',
      allowRulesDescription:
        'read / write / edit inside the sandbox writable roots run directly, without an LLM review.',
      globalPromptTitle: 'Global prompt',
      globalPromptDescription:
        'Applies to every session. Only adds a constraint — it can narrow a decision but never authorize a riskier action.',
      globalPromptPlaceholder: 'For example: this project uses pnpm; test and lint are routine.',
      workspaceDescription:
        'Matched against the session working directory. The longest matching path wins.',
      workspacePathPlaceholder: 'Absolute workspace path, e.g. D:\\work\\project',
      workspacePromptPlaceholder: 'Prompt appended for this workspace',
      add: 'Add',
      browse: 'Browse…',
      pickFromWorkspaces: 'Pick a registered workspace…',
      browseUnavailable: 'The directory picker is not available here; type the path instead.',
      saved: 'Prompt saved',
      removed: 'Removed',
      remove: 'Remove',
      save: 'Save',
      saved: 'Saved',
      failed: 'Could not save',
      loading: 'Loading…',
      unavailable: 'This deployment does not expose these settings to the browser.',
      readOnly: 'This configuration is read-only in the current connection.',
      none: 'None yet.',
      promptUnavailable: 'The prompt file channel is not available in this deployment.',
      promptNotReady: 'The prompt channel is not ready yet; editing is disabled.',
      constraintNote:
        'Prompts are constraints: they can only narrow a decision, never authorize a riskier one. The reviewer policy itself is fixed by the host.',
    }

    const zh = {
      title: 'Auto Review',
      sectionPermission: '权限',
      sectionPrompt: '审查提示词',
      sectionWorkspace: '工作区提示词',
      defaultPresetTitle: '新会话默认启用 Auto review',
      defaultPresetDescription: '新建会话后自动切换到 Auto review 权限预设。',
      promptsTitle: '注入审查提示词',
      promptsDescription: '把你的判断口径追加进审查请求，让审查模型了解这个项目。',
      allowRulesTitle: '工作区内文件编辑免审',
      allowRulesDescription: '沙箱可写根内的 read / write / edit 直接执行，不发起 LLM 审查。',
      globalPromptTitle: '全局提示词',
      globalPromptDescription:
        '对所有会话生效。只能追加约束——能让判断更准，但不能把更高风险的动作变成放行。',
      globalPromptPlaceholder: '例如：本项目使用 pnpm；test 与 lint 属于常规操作。',
      workspaceDescription: '按会话工作目录匹配，多个命中时取路径最长的那个。',
      workspacePathPlaceholder: '工作区绝对路径，例如 D:\\work\\project',
      workspacePromptPlaceholder: '为该工作区追加的提示词',
      add: '添加',
      browse: '选择目录…',
      pickFromWorkspaces: '从已注册工作区选择…',
      browseUnavailable: '这里没有目录选择器，请手动输入路径。',
      saved: '已保存',
      removed: '已删除',
      remove: '删除',
      save: '保存',
      saved: '已保存',
      failed: '保存失败',
      loading: '加载中…',
      unavailable: '当前部署没有把这组设置暴露给浏览器。',
      readOnly: '当前连接下这份配置是只读的。',
      none: '还没有。',
      promptUnavailable: '当前部署没有提供提示词文件通道。',
      promptNotReady: '提示词通道尚未就绪，暂时无法编辑。',
      constraintNote:
        '提示词是约束：只能收窄判断，不能授权更危险的动作。审查策略本身由宿主固定。',
    }

    // ── 样式（只用主题 token）───────────────────────────────────────────
    const css = `
.arc-page { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; }
.arc-title { font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary); margin: 0 0 4px; }
.arc-subtitle {
  font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary);
  text-transform: uppercase; letter-spacing: .04em; margin: 20px 0 4px;
}
.arc-row {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 24px;
  padding: 14px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.arc-row-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.arc-row-title { font-size: 14px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.arc-row-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.arc-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); padding: 8px 0; }
.arc-notice { font-size: 12px; line-height: 18px; padding: 8px 0; color: var(--dsw-alias-label-secondary); }
.arc-notice[data-tone="success"] { color: var(--dsw-alias-state-success-primary); }
.arc-notice[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.arc-switch {
  position: relative; flex: none; width: 40px; height: 22px; padding: 0;
  border: none; border-radius: 11px; cursor: pointer;
  background: var(--dsw-alias-state-idle-primary); transition: background 120ms ease;
}
.arc-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.arc-switch:disabled { opacity: .5; cursor: not-allowed; }
.arc-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.arc-knob {
  position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
  border-radius: 50%; background: var(--dsw-alias-bg-base); transition: transform 120ms ease;
}
.arc-switch[aria-checked="true"] .arc-knob { transform: translateX(18px); }
.arc-block { display: flex; flex-direction: column; gap: 8px; padding: 14px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.arc-textarea, .arc-input {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 8px 10px;
  resize: vertical;
}
.arc-textarea:focus, .arc-input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.arc-textarea { min-height: 88px; }
.arc-actions { display: flex; gap: 8px; align-items: center; }
.arc-btn {
  font: inherit; font-size: 13px; line-height: 18px; padding: 6px 14px; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 6px;
}
.arc-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l1); }
.arc-btn:disabled { opacity: .5; cursor: not-allowed; }
.arc-btn-primary {
  color: var(--dsw-alias-bg-base); background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.arc-ws-item { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; }
.arc-ws-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.arc-ws-path {
  font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--dsw-alias-label-secondary); word-break: break-all;
}
.arc-divider { height: 0.5px; background: var(--dsw-alias-border-l2); }
.arc-banner {
  display: flex; align-items: center; gap: 8px; margin: 10px 0 4px;
  padding: 10px 14px; border-radius: 8px; border: 1px solid transparent;
  font-size: 13px; line-height: 20px; font-weight: 500;
  background: var(--dsw-alias-bg-layer-2);
}
.arc-banner[data-tone="success"] {
  border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
}
.arc-banner[data-tone="error"] {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
.arc-banner-mark { font-weight: 700; }
.arc-path-row { display: flex; gap: 8px; align-items: center; }
.arc-path-row > .arc-input { flex: 1 1 auto; min-width: 0; }
`

    /** 可访问开关。 */
    function Switch({ checked, disabled, label, onChange }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label,
          className: 'arc-switch',
          disabled,
          onClick: () => onChange(!checked),
        },
        h('span', { className: 'arc-knob' }),
      )
    }

    /** 一行：说明 + 右侧开关。 */
    function ToggleRow({ titleKey, descriptionKey, checked, disabled, onChange, t }) {
      const title = t(titleKey)
      return h(
        'div',
        { className: 'arc-row' },
        h(
          'div',
          { className: 'arc-row-text' },
          h('div', { className: 'arc-row-title' }, title),
          h('div', { className: 'arc-row-desc' }, t(descriptionKey)),
        ),
        h(Switch, { checked, disabled, label: title, onChange }),
      )
    }

    /** 一个工作区档。 */
    function WorkspaceItem({ entry, disabled, onSave, onRemove, t }) {
      const [draft, setDraft] = React.useState(entry.prompt)
      React.useEffect(() => setDraft(entry.prompt), [entry.prompt])

      return h(
        'div',
        { className: 'arc-ws-item' },
        h(
          'div',
          { className: 'arc-ws-head' },
          h('span', { className: 'arc-ws-path' }, entry.path),
          h(
            'button',
            { type: 'button', className: 'arc-btn', disabled, onClick: () => onRemove(entry.name) },
            t('remove'),
          ),
        ),
        h('textarea', {
          className: 'arc-textarea',
          value: draft,
          disabled,
          placeholder: t('workspacePromptPlaceholder'),
          onChange: (event) => setDraft(event.target.value),
        }),
        h(
          'div',
          { className: 'arc-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'arc-btn arc-btn-primary',
              // 同上：不按「有没有改」禁用，避免"看得到点不动"的困惑。
              disabled,
              onClick: () => onSave(entry.path, draft),
            },
            t('save'),
          ),
        ),
        h('div', { className: 'arc-divider' }),
      )
    }

    /**
     * 解包 Remote 调用的返回信封。
     *
     * 客户端网关**总是**返回 `{ ok: true, value }` 或 `{ ok: false, error }`
     * （见 `dsh-api-gateway` 的 `rpcFailure` / 成功分支）。调用方拿到的不是业务
     * 值本身——不拆包就会一直读到 `undefined`。
     *
     * 兼容性：如果将来某处直接返回业务值（没有 `ok` 字段），也当成功处理。
     *
     * @param {unknown} envelope
     * @returns {any | null} 业务值；信封表示失败时返回 null。
     */
    function unwrapRemote(envelope) {
      if (envelope === null || typeof envelope !== 'object') return null
      const record = /** @type {Record<string, unknown>} */ (envelope)
      if (typeof record.ok !== 'boolean') return envelope
      return record.ok === true ? record.value : null
    }

    /**
     * 把失败信封转成一行可读文字。
     *
     * @param {unknown} envelope
     * @returns {string}
     */
    function describeRemoteFailure(envelope) {
      const record =
        envelope !== null && typeof envelope === 'object'
          ? /** @type {Record<string, any>} */ (envelope)
          : {}
      const error = record.error
      if (error !== null && typeof error === 'object') {
        const code = typeof error.code === 'string' ? error.code : 'unknown'
        const message = typeof error.message === 'string' ? error.message : ''
        return `${code}${message === '' ? '' : `: ${message}`}`
      }
      return `remote 调用失败：${JSON.stringify(envelope)?.slice(0, 200) ?? String(envelope)}`
    }

    /** 设置页主体。 */
    function Page({ useForm, setField, unsetField, loadPromptApi, pickDirectory, t }) {
      const snapshot = useForm((value) => value)
      const settings = snapshot.value ?? {}
      const ready = snapshot.status === 'ready'
      const configDisabled = !ready || !snapshot.writable

      const [notice, setNotice] = React.useState(null)
      /** 横幅序号：连续操作时强制重新计时。 */
      const seqRef = React.useRef(0)
      React.useEffect(() => {
        if (notice === null) return undefined
        // 3.5 秒，够看清；连续的操作用 seq 重置计时。
        const timer = setTimeout(() => setNotice(null), 3500)
        return () => clearTimeout(timer)
      }, [notice?.seq])

      // ── 提示词状态（来自 Remote，惰性挂载）───────────────────────────
      const [promptApi, setPromptApi] = React.useState(null)
      const [promptError, setPromptError] = React.useState(null)
      const [promptState, setPromptState] = React.useState({
        status: 'loading',
        global: '',
        workspaces: [],
        raw: '',
      })

      // 页面打开时才挂 Remote：这时客户端启动早已完成，网关队列是空的。
      React.useEffect(() => {
        let alive = true
        loadPromptApi()
          .then((mounted) => {
            if (!alive) return
            setPromptApi(mounted.api)
            setPromptError(mounted.error)
            if (mounted.api === null) {
              setPromptState({ status: 'unavailable', global: '', workspaces: [], raw: '' })
            }
          })
          .catch((error) => {
            if (!alive) return
            setPromptError(String(error?.message ?? error))
            setPromptState({ status: 'unavailable', global: '', workspaces: [], raw: '' })
          })
        return () => {
          alive = false
        }
      }, [loadPromptApi])

      const refreshPrompts = React.useCallback(async () => {
        if (promptApi === null || promptApi === undefined) return
        try {
          // Remote 调用返回**信封**：成功 `{ok:true, value}`，失败 `{ok:false, error}`。
          // 必须解包，否则永远读到 undefined。
          const envelope = await promptApi.read()
          const payload = unwrapRemote(envelope)
          if (payload === null) {
            setPromptState({
              status: 'error',
              global: '',
              workspaces: [],
              raw: describeRemoteFailure(envelope),
            })
            return
          }
          setPromptState({
            status: 'ready',
            global: typeof payload.global === 'string' ? payload.global : '',
            workspaces: Array.isArray(payload.workspaces) ? payload.workspaces : [],
            raw: '',
          })
        } catch (error) {
          setPromptState({
            status: 'error',
            global: '',
            workspaces: [],
            raw: `read() 抛错：${String(error?.message ?? error)}`,
          })
        }
      }, [promptApi])

      React.useEffect(() => {
        refreshPrompts()
      }, [refreshPrompts])

      // ── 已注册工作区（供下拉选择，避免手输路径）─────────────────────
      const [registeredWorkspaces, setRegisteredWorkspaces] = React.useState([])

      React.useEffect(() => {
        if (promptApi === null || promptApi === undefined) return undefined
        let alive = true
        ;(async () => {
          try {
            const list = unwrapRemote(await promptApi.listWorkspaces())
            if (!alive || !Array.isArray(list)) return
            setRegisteredWorkspaces(
              list.filter(
                (entry) =>
                  entry !== null && typeof entry === 'object' && typeof entry.path === 'string',
              ),
            )
          } catch (_error) {
            /* 下拉只是便利功能，拿不到就退化成手输 + 浏览。 */
          }
        })()
        return () => {
          alive = false
        }
      }, [promptApi])

      const promptDisabled = promptState.status !== 'ready'

      const storedGlobal = promptState.global
      const [globalDraft, setGlobalDraft] = React.useState(storedGlobal)
      React.useEffect(() => setGlobalDraft(storedGlobal), [storedGlobal])

      const [newPath, setNewPath] = React.useState('')
      const [newPrompt, setNewPrompt] = React.useState('')

      /**
       * 跑一个写操作，成功后重新拉取并弹出结果横幅。
       *
       * `seq` 递增用来强制横幅重新计时：连续保存两次时，第二次也要重新显示
       * 3.5 秒，而不是沿用上一次的计时。
       *
       * @param operation - 返回 Promise 的写动作。
       * @param after - 成功后的本地清理。
       * @param successKind - 成功时显示的文案 key。
       */
      const run = async (operation, after, successKind = 'saved') => {
        const seq = (seqRef.current += 1)
        setNotice(null)
        let accepted = false
        try {
          const result = await operation()
          accepted = result === undefined ? true : result?.ok !== false
        } catch (_error) {
          accepted = false
        }
        if (accepted && typeof after === 'function') after()
        if (accepted) await refreshPrompts()
        setNotice({ kind: accepted ? successKind : 'failed', seq })
        return accepted
      }

      /**
       * 开关 → 配置字段的取值映射。
       *
       * ⚠️ 开关组件（`Switch`/`ToggleRow`）只产出**布尔值**，但 Config schema 里
       * 的字段类型并不全是布尔：`defaultPreset` 是 `'auto' | 'off'` 字符串联合
       * （见 `lib/schema.js`）。把 `true/false` 原样透传会直接被宿主 schema 拒绝：
       *
       * ```
       * ValidationError: invalid config:
       *   - $.defaultPreset expected "auto" | "off" but got true
       * ```
       *
       * 表现就是「点开关 = 保存失败」，而且不崩溃、只在下次读取时看出没落盘。
       * 所以**每个非布尔字段都必须在这里登记**，不允许靠调用点各自转换。
       */
      const BOOLEAN_FIELD_VALUES = Object.freeze({
        defaultPreset: { on: 'auto', off: 'off' },
      })

      /** 把开关的布尔值转成该字段 schema 要求的取值；布尔字段原样返回。 */
      const fieldValue = (field, next) => {
        const mapping = BOOLEAN_FIELD_VALUES[field]
        return mapping === undefined ? next : next ? mapping.on : mapping.off
      }

      const toggle = (field) => async (next) => {
        const seq = (seqRef.current += 1)
        setNotice(null)
        let accepted = false
        try {
          accepted = (await setField(field, fieldValue(field, next))) === true
        } catch (_error) {
          accepted = false
        }
        setNotice({ kind: accepted ? 'saved' : 'failed', seq })
      }

      const saveGlobal = () => run(() => promptApi.writeGlobal(globalDraft))
      const clearGlobal = () => run(() => promptApi.writeGlobal(''), () => setGlobalDraft(''), 'removed')

      const addWorkspace = () => {
        const path = newPath.trim()
        const prompt = newPrompt.trim()
        if (path === '' || prompt === '') return Promise.resolve(false)
        return run(
          () => promptApi.writeWorkspace(path, prompt),
          () => {
            setNewPath('')
            setNewPrompt('')
          },
        )
      }

      const saveWorkspace = (path, text) => run(() => promptApi.writeWorkspace(path, text))
      const removeWorkspace = (name) => run(() => promptApi.removeWorkspace(name), undefined, 'removed')

      /** 打开宿主原生目录选择器；不可用时给出说明而不是静默失败。 */
      const browse = async () => {
        const picked = await pickDirectory()
        if (typeof picked === 'string' && picked !== '') {
          setNewPath(picked)
          return
        }
        if (picked === null) setNotice({ kind: 'browseUnavailable', seq: (seqRef.current += 1) })
      }

      return h(
        'div',
        { className: 'arc-page' },
        h('h2', { className: 'arc-title' }, t('title')),

        snapshot.status === 'loading' ? h('div', { className: 'arc-hint' }, t('loading')) : null,
        snapshot.status === 'unavailable'
          ? h('div', { className: 'arc-hint' }, t('unavailable'))
          : null,
        ready && !snapshot.writable
          ? h('div', { className: 'arc-hint' }, t('readOnly'))
          : null,

        // ── 操作结果横幅（顶部，醒目）───────────────────────────────────
        notice !== null
          ? h(
              'div',
              {
                className: 'arc-banner',
                role: 'status',
                'data-tone': notice.kind === 'failed' ? 'error' : 'success',
                // key 用 seq：连续两次保存都会重新出现，而不是沿用旧横幅。
                key: notice.seq,
              },
              h('span', { className: 'arc-banner-mark' }, notice.kind === 'failed' ? '✕' : '✓'),
              h('span', null, t(notice.kind)),
            )
          : null,

        // ── 权限 ────────────────────────────────────────────────────────
        h('div', { className: 'arc-subtitle' }, t('sectionPermission')),
        h(ToggleRow, {
          titleKey: 'defaultPresetTitle',
          descriptionKey: 'defaultPresetDescription',
          checked: settings.defaultPreset === 'auto',
          disabled: configDisabled,
          onChange: toggle('defaultPreset'),
          t,
        }),
        h(ToggleRow, {
          titleKey: 'allowRulesTitle',
          descriptionKey: 'allowRulesDescription',
          checked: settings.allowRules !== false,
          disabled: configDisabled,
          onChange: toggle('allowRules'),
          t,
        }),

        // ── 审查提示词 ──────────────────────────────────────────────────
        h('div', { className: 'arc-subtitle' }, t('sectionPrompt')),
        h(ToggleRow, {
          titleKey: 'promptsTitle',
          descriptionKey: 'promptsDescription',
          checked: settings.prompts !== false,
          disabled: configDisabled,
          onChange: toggle('prompts'),
          t,
        }),

        promptState.status === 'unavailable'
          ? h('div', { className: 'arc-hint' }, t('promptUnavailable'))
          : null,
        promptError !== null && promptError !== undefined
          ? h(
              'div',
              { className: 'arc-hint', 'data-tone': 'error', style: { color: 'var(--dsw-alias-state-error-primary)' } },
              `通道错误：${String(promptError)}`,
            )
          : null,
        promptState.status === 'loading' ? h('div', { className: 'arc-hint' }, t('loading')) : null,
        // 通道没就绪时明确说明，别让用户对着灰按钮猜。
        promptDisabled && promptState.status !== 'loading'
          ? h('div', { className: 'arc-hint' }, t('promptNotReady'))
          : null,
        // 只有失败时才会有值：显示 Remote 返回的错误码与原话。
        promptState.raw
          ? h(
              'div',
              {
                className: 'arc-hint',
                style: {
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  wordBreak: 'break-all',
                  color: 'var(--dsw-alias-state-error-primary)',
                },
              },
              `读取提示词失败：${promptState.raw}`,
            )
          : null,

        h(
          'div',
          { className: 'arc-block' },
          h(
            'div',
            { className: 'arc-row-text' },
            h('div', { className: 'arc-row-title' }, t('globalPromptTitle')),
            h('div', { className: 'arc-row-desc' }, t('globalPromptDescription')),
          ),
          h('textarea', {
            className: 'arc-textarea',
            value: globalDraft,
            disabled: promptDisabled,
            placeholder: t('globalPromptPlaceholder'),
            onChange: (event) => setGlobalDraft(event.target.value),
          }),
          h(
            'div',
            { className: 'arc-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'arc-btn arc-btn-primary',
                // 不按「内容有没有变」禁用：用户看到一段文字却点不动按钮，
                // 只会以为坏了。重复保存同一内容是幂等的，没有副作用。
                disabled: promptDisabled,
                onClick: saveGlobal,
              },
              t('save'),
            ),
          ),
        ),

        // ── 工作区提示词 ────────────────────────────────────────────────
        h('div', { className: 'arc-subtitle' }, t('sectionWorkspace')),
        h('div', { className: 'arc-hint' }, t('workspaceDescription')),

        promptState.workspaces.length === 0
          ? h('div', { className: 'arc-hint' }, t('none'))
          : promptState.workspaces.map((entry) =>
              h(WorkspaceItem, {
                key: entry.name,
                entry,
                disabled: promptDisabled,
                onSave: saveWorkspace,
                onRemove: removeWorkspace,
                t,
              }),
            ),

        h(
          'div',
          { className: 'arc-block' },
          // ① 从已注册工作区里选（最常见；路径保证准确、拼写一致）。
          registeredWorkspaces.length > 0
            ? h(
                'select',
                {
                  className: 'arc-input',
                  value: '',
                  disabled: promptDisabled,
                  onChange: (event) => {
                    if (event.target.value !== '') setNewPath(event.target.value)
                  },
                },
                h('option', { value: '' }, t('pickFromWorkspaces')),
                ...registeredWorkspaces.map((entry) =>
                  h(
                    'option',
                    { key: entry.id || entry.path, value: entry.path },
                    entry.title === '' ? entry.path : `${entry.title} — ${entry.path}`,
                  ),
                ),
              )
            : null,
          // ② 也可以手输，或用宿主原生选择器挑任意目录。
          h(
            'div',
            { className: 'arc-path-row' },
            h('input', {
              className: 'arc-input',
              value: newPath,
              disabled: promptDisabled,
              placeholder: t('workspacePathPlaceholder'),
              onChange: (event) => setNewPath(event.target.value),
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'arc-btn',
                disabled: promptDisabled,
                // 宿主原生目录选择器（uiWorkspace.pickDirectory）；不可用时 browse()
                // 会给出说明，而不是让按钮点下去毫无反应。
                onClick: browse,
              },
              t('browse'),
            ),
          ),
          h('textarea', {
            className: 'arc-textarea',
            value: newPrompt,
            disabled: promptDisabled,
            placeholder: t('workspacePromptPlaceholder'),
            onChange: (event) => setNewPrompt(event.target.value),
          }),
          h(
            'div',
            { className: 'arc-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'arc-btn',
                disabled: promptDisabled || newPath.trim() === '' || newPrompt.trim() === '',
                onClick: addWorkspace,
              },
              t('add'),
            ),
          ),
        ),

        h('div', { className: 'arc-hint' }, t('constraintNote')),
      )
    }

    /**
     * **惰性**挂载 Remote 通道（同一个会话只挂一次）。
     *
     * ## 为什么不在 `apply` 里挂
     *
     * `dsh-api-gateway` 的 `$mount`（`lib/client.js:1636-1646`）把挂载动作塞进
     * 一条**全局串行的 mutation 队列**（`enqueue`，`:1657-1660`）：
     *
     * ```js
     * enqueue(operation) {
     *   const result = this.mutations.then(operation, operation)
     *   this.mutations = result.then(() => void 0, () => void 0)
     *   return result
     * }
     * ```
     *
     * 客户端启动时 `dsh-api-remotes` 要挂约 25 个内置命名空间（`sessions`、
     * `modelSelection` 等），走的也是这条队列。**在 `apply` 阶段挂载会插进
     * 启动序列**：一旦这次挂载异常或停顿，排在它后面的内置命名空间就装不上，
     * 表现就是「新会话能打开，但消息发不出去」。实测已确认：把客户端半区摘掉后
     * 发消息恢复正常。
     *
     * 所以改成：`apply` **保持同步**，一个网络/挂载动作都不做；等用户真正打开
     * 设置页时才挂载。那时启动早已完成，队列是空的，失败也只影响这一页。
     *
     * @param {any} ctx
     * @returns {Promise<{ api: any, error: string | null }>}
     */
    function mountPromptRemote(ctx) {
      if (promptMount !== null) return promptMount

      promptMount = (async () => {
        const remote = ctx.get?.('remote') ?? ctx.remote
        if (remote === undefined || typeof remote?.$mount !== 'function') {
          return { api: null, error: 'ctx.remote.$mount 不可用（宿主没有 Remote 网关）' }
        }
        try {
          const disposer = await remote.$mount(TYPERT_REMOTE)
          ctx.effect(() => disposer, 'auto-review-custom remote')
        } catch (error) {
          return { api: null, error: `$mount 失败：${String(error?.message ?? error)}` }
        }
        const face =
          ctx.get?.(`remote.${REMOTE_NAMESPACE}`) ??
          ctx.remote?.[REMOTE_NAMESPACE] ??
          null
        if (face === null) {
          return { api: null, error: `已挂载但 remote.${REMOTE_NAMESPACE} 未出现` }
        }
        return { api: face, error: null }
      })()

      return promptMount
    }

    return {
      inject: ['slots', 'locale', 'configForms'],

      apply(ctx) {
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-auto-review-custom'
          tag.textContent = css
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'auto-review-custom styles')

        ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'auto-review-custom locale')

        // 表单归属方是 Host 插件的 loader entry id，不是包名。
        const form = ctx.configForms.get(ENTRY_ID)

        ctx.effect(
          () =>
            ctx.configForms.whileServed([ENTRY_ID], () =>
              ctx.slots.inject('settings.section', () =>
                ctx.slots.register(
                  {
                    name: 'settings.section',
                    id: ENTRY_ID,
                    order: 120,
                    label: () => 'Auto Review',
                    locale: LOCALE_NS,
                    inject: () => ({
                      hooks: { form },
                      setField: (field, value) => form.set(field, value),
                      unsetField: (field) => form.unset(field),
                      loadPromptApi: () => mountPromptRemote(ctx),
                      // 目录选择器是宿主的可选服务（`uiWorkspace.pickDirectory`，
                      // 「Open the Host-native directory picker」）。取不到时返回
                      // null，由页面给出「这里没有选择器」的说明。
                      pickDirectory: async () => {
                        const workspace = ctx.get?.('uiWorkspace') ?? ctx.uiWorkspace
                        if (workspace === undefined || typeof workspace?.pickDirectory !== 'function') {
                          return null
                        }
                        try {
                          return await workspace.pickDirectory()
                        } catch (_error) {
                          return null
                        }
                      },
                    }),
                  },
                  Page,
                ),
              ),
            ),
          'auto-review-custom settings page',
        )
      },
    }
  },
})
