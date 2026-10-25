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
     * `$mount` 的超时毫秒数。
     *
     * 网关把挂载塞进一条全局串行队列；队列被启动期的内置命名空间占住时
     * `$mount` 可能长时间不 settle。没有超时就会表现为"页签永远未就绪"，
     * 而这在 UI 上和"没有数据"长得一模一样。
     */
    const MOUNT_TIMEOUT_MS = 8000

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
        descriptor('readSession', ['sessionId']),
        descriptor('writeSession', ['sessionId', 'text']),
        descriptor('listSessions', []),
        descriptor('readSessionContext', ['sessionId']),
        descriptor('readWorkspacePrompt', ['workspacePath']),
        objectDescriptor('queryDenials', 'filter'),
      ],
    }

    /**
     * 造一条**参数是单个对象**的调用描述符。
     *
     * 与 `param()` 的差别只在 codec：对象参数用 `z.record` 语义（任意键 →
     * 任意值），这样筛选条件天然可缺省，不必为每个条件铺一个位置参数。
     */
    function objectDescriptor(method, name) {
      return {
        id: `dsh-auto-review-custom#autoReviewPrompts/${method}`,
        service: 'autoReviewPrompts',
        namespace: 'autoReviewPrompts',
        method,
        invocation: { kind: 'direct' },
        parameters: [
          {
            name,
            wire: name,
            source: 'json',
            codec: {
              mode: 'strict',
              typeSymbol: `dsh-auto-review-custom#autoReviewPrompts/${method}:parameter:0`,
              // 客户端从不调用 create（参数原样进 args[wire]），给最小可自证实现。
              create: () => ({
                parse: (value) => {
                  if (value === null || typeof value !== 'object') throw new Error('expected object')
                  return value
                },
                safeParse: (value) =>
                  value !== null && typeof value === 'object'
                    ? { success: true, data: value }
                    : { success: false, error: new Error('expected object') },
              }),
            },
          },
        ],
        result: { mode: 'src-json' },
      }
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
      // ── 会话页签（0.2.0）────────────────────────────────────────────
      tabTitle: 'AutoReview',
      tabGuideTitle: 'AutoReview',
      tabGuideDescription: 'Review prompts and denials for this workspace and session',
      workspacePromptTitle: 'Current workspace',
      workspacePromptDescription:
        'Applies to every session whose working directory is under this workspace prompt.',
      workspacePromptPlaceholder:
        'For example: this repo is a DSH plugin; run `node scripts/selftest.mjs` after edits.',
      workspaceNoMatch:
        'No workspace prompt matches this session’s directory yet. Saving below creates one.',
      pickWorkspaceFallback: 'Pick a registered workspace…',
      workspaceNoPromptYet: 'This workspace has no prompt yet — saving creates one.',
      sessionPromptTitle: 'This session',
      sessionPromptDescription:
        'Appended after the workspace prompt, and only for review requests from this session.',
      sessionPromptPlaceholder:
        'For example: in this session, `pnpm pack` is allowed — I already said the old tarball can be replaced.',
      denialsTitle: 'Recorded denials',
      denialsDescription:
        'Newest first. Each row is one call the reviewer refused; feed the reason into a prompt above.',
      denialsEmpty: 'No denial recorded for this scope yet.',
      denialsScope: 'Scope',
      denialsAll: 'All',
      denialsThisSession: 'This session',
      denialsThisWorkspace: 'This workspace',
      appendAsPrompt: 'Append to prompt',
      appendPrefix: 'Allowed here: ',
      refresh: 'Refresh',
      scopeSession: 'Session',
      scopeWorkspace: 'Workspace',
      autoOnlyHint:
        'This session is not using the Auto review preset, so the reviewer is not running. Switch the session to Auto review to manage its prompts here.',
      cwdLabel: 'cwd',
      sessionDefaultTitle: 'AutoReview',
      retryChannel: 'Retry',
      channelConnecting: 'Connecting to the prompt file channel…',
      channelNotReady: 'The prompt file channel is not ready, so nothing below can load or save.',
      channelLoadingData: 'Loading this session’s prompts and denials…',
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
      // ── 会话页签（0.2.0）────────────────────────────────────────────
      tabTitle: 'AutoReview 管理',
      tabGuideTitle: 'AutoReview 管理',
      tabGuideDescription: '维护本工作区与本会话的审查提示词、查看拒绝记录',
      workspacePromptTitle: '当前工作区',
      workspacePromptDescription:
        '对所有工作目录落在这个工作区之下的会话生效。',
      workspacePromptPlaceholder:
        '例如：本仓库是 DSH 插件，改完必须跑 `node scripts/selftest.mjs`。',
      workspaceNoMatch:
        '当前会话目录还没有匹配的工作区档。在下面保存会新建一个。',
      pickWorkspaceFallback: '从已注册工作区选择…',
      workspaceNoPromptYet: '该工作区还没有提示词——保存即新建。',
      sessionPromptTitle: '当前会话',
      sessionPromptDescription:
        '排在工作区之后生效，且只作用于这个会话发起的审查请求。',
      sessionPromptPlaceholder:
        '例如：本会话允许 `pnpm pack`——我已确认旧 tarball 可以覆盖。',
      denialsTitle: '被拒绝的记录',
      denialsDescription:
        '新的在前。每行是一次被审查器拒绝的调用，理由可以直接喂给上面的提示词。',
      denialsEmpty: '当前范围内还没有被拒绝的记录。',
      denialsScope: '范围',
      denialsAll: '全部',
      denialsThisSession: '本会话',
      denialsThisWorkspace: '本工作区',
      appendAsPrompt: '追加为提示词',
      appendPrefix: '本会话允许：',
      refresh: '刷新',
      scopeSession: '会话',
      scopeWorkspace: '工作区',
      autoOnlyHint:
        '当前会话没有使用 Auto review 预设，审查器并未运行。把会话切到 Auto review 后才能在这里维护它的提示词。',
      cwdLabel: '目录',
      sessionDefaultTitle: 'AutoReview 管理',
      retryChannel: '重试',
      channelConnecting: '正在连接提示词文件通道…',
      channelNotReady: '提示词文件通道未就绪，下面的内容无法加载或保存。',
      channelLoadingData: '正在加载本会话的提示词与拒绝记录…',
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
/* ── 会话页签（右栏 tab）────────────────────────────────────────────── */
.arc-tab {
  display: flex; flex-direction: column; gap: 10px;
  height: 100%; min-height: 0; overflow-y: auto;
  padding: 12px 14px 16px; box-sizing: border-box;
  background: var(--dsw-alias-bg-base);
}
.arc-tab-head { display: flex; flex-direction: column; gap: 2px; }
.arc-tab-title { font-size: 14px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.arc-tab-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.arc-tab-section { display: flex; flex-direction: column; gap: 6px; min-height: 0; }
.arc-tab-subtitle {
  font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary);
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.arc-tab textarea.arc-textarea { min-height: 110px; font-size: 12px; line-height: 18px; }
.arc-tab-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.arc-select {
  font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 5px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l2);
}
.arc-denial-list { display: flex; flex-direction: column; gap: 6px; }
.arc-denial {
  display: flex; flex-direction: column; gap: 4px;
  padding: 8px 10px; border-radius: 6px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.arc-denial-top { display: flex; align-items: center; gap: 8px; }
.arc-denial-kind {
  font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px;
  color: var(--dsw-alias-bg-base); background: var(--dsw-alias-state-error-primary);
}
.arc-denial-kind[data-kind="ask"] { background: var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-idle-primary)); }
.arc-denial-kind[data-kind="fail"] { background: var(--dsw-alias-label-secondary); }
.arc-denial-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.arc-denial-reason {
  font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-primary);
  white-space: pre-wrap; word-break: break-word;
}
.arc-denial-arg {
  font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all; opacity: .9;
}
.arc-denial-actions { display: flex; gap: 6px; }
.arc-btn-sm { font-size: 11px; padding: 3px 9px; }
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

    // ════════════════════════════════════════════════════════════════════
    // 会话页签（右栏 sidebar.right.pane.tab，0.2.0 新增）
    // ════════════════════════════════════════════════════════════════════

    /** 页签类型 id —— 必须是稳定的包级标识（同 kind 只能有一个 extension）。 */
    const SESSION_TAB_ID = 'dsh-auto-review-custom/session-prompt'

    /** 页签 kind —— `ctx.sidebarRight.openTab(kind)` 用它打开。 */
    const SESSION_TAB_KIND = 'auto-review-session-prompt'

    /**
     * AutoReview 管理页签的正文组件。
     *
     * ## 它解决什么
     *
     * 0.1.x 里想给"就这一次会话"调口径，只能去改工作区档——那会影响同一工作区
     * 的**所有**会话。这个页签把**两档提示词 + 两档拒绝记录**摆在会话自己旁边。
     *
     * ## sessionId 与 cwd 从哪来
     *
     * `sidebar.right.pane.tab` 是 `scope: 'session'` 的槽位，框架给
     * `SessionStandardProps`：`sessionId` 直接用；cwd 由 Host 按 sessionId 反查
     * （`ctx.remote.autoReviewPrompts.readSessionContext`），**不在浏览器侧猜**。
     *
     * ## auto 预设门禁
     *
     * 用户只在 Auto review 预设下才需要维护这些提示词。`useProjection('permissions')`
     * 给出 `{ currentValue }`（见 `dsh-permission-presets` 的 `PermissionSelection`），
     * 不是 `auto` 就显示说明并禁用编辑。
     *
     * @param {object} props
     */
    function SessionTab(props) {
      const { sessionId, useProjection, loadPromptApi, t } = props

      /** `null` = 还在挂载通道；`{ api }` / `{ error }`。 */
      const [channel, setChannel] = React.useState(null)
      const [workspace, setWorkspace] = React.useState({ name: null, path: null, prompt: '' })
      const [registeredWorkspaces, setRegisteredWorkspaces] = React.useState([])
      const [sessionDraft, setSessionDraft] = React.useState('')
      const [workspaceDraft, setWorkspaceDraft] = React.useState('')
      const [loaded, setLoaded] = React.useState(false)
      const [scope, setScope] = React.useState('session')
      const [denials, setDenials] = React.useState([])
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      /** 通道重试计数：递增即让挂载 effect 重跑（失败不缓存，见 mountPromptRemote）。 */
      const [mountAttempt, setMountAttempt] = React.useState(0)
      const seqRef = React.useRef(0)

      // 权限投影：`auto` 才是 Auto review 预设（见 dsh-permission-presets）。
      const permissions = useProjection('permissions')
      const preset = typeof permissions?.currentValue === 'string' ? permissions.currentValue : null
      const autoEnabled = preset === null || preset === 'auto'

      const say = (kind) => setNotice({ kind, seq: (seqRef.current += 1) })

      // ── 挂载 Remote 通道（惰性，和设置页共用同一个单例）───────────────
      React.useEffect(() => {
        let alive = true
        Promise.resolve(loadPromptApi())
          .then((result) => {
            if (alive) setChannel(result)
          })
          .catch((error) => {
            if (alive) setChannel({ api: null, error: String(error?.message ?? error) })
          })
        return () => {
          alive = false
        }
      }, [loadPromptApi, mountAttempt])

      const api = channel === null ? null : channel.api ?? null

      /**
       * 一次性拉齐：会话上下文（cwd + 命中的工作区档）、两档提示词、拒绝记录。
       *
       * 任何一项失败都只提示、不抛：页签可用性不该因为通道抖动而崩溃。
       */
      const refresh = React.useCallback(async () => {
        if (api === null) return
        setBusy(true)
        try {
          // ⚠️ 每个 Remote 调用都必须 `unwrapRemote` 拆信封！
          //
          // 网关**总是**返回 `{ok:true, value}` / `{ok:false, error}`（本文件
          // 「三个必须知道的坑」第 2 条）。不拆包时 `context.cwd` 恒为
          // `undefined`，于是「目录」显示 `—`、两档提示词读成空、拒绝记录读成
          // 空、兜底下拉也读成空——**看起来就像通道没通或没有数据**，而且不抛错。
          // 设置页之所以一直正常，就是因为它每个调用都拆了包。
          const context = unwrapRemote(await api.readSessionContext(sessionId))
          if (context === null) {
            say('failed')
            return
          }
          const cwd = typeof context?.cwd === 'string' ? context.cwd : null
          const matched = context?.workspace ?? null

          const [workspacePromptResult, sessionPromptResult, denialResult, registered] = await Promise.all([
            matched === null ? Promise.resolve({ prompt: '' }) : api.readWorkspacePrompt(matched.path).then(unwrapRemote),
            api.readSession(sessionId).then(unwrapRemote),
            api
              .queryDenials(
                scope === 'session'
                  ? { sessionId, limit: 30 }
                  : cwd === null
                    ? { limit: 30 }
                    : { cwd, limit: 30 },
              )
              .then(unwrapRemote),
            // 兜底候选：cwd 反查失败时让人从已注册工作区里挑，避免彻底死锁。
            api.listWorkspaces().then(unwrapRemote).catch(() => []),
          ])

          setRegisteredWorkspaces(Array.isArray(registered) ? registered : [])
          setWorkspace({
            name: matched === null ? null : matched.name,
            path: matched === null ? cwd : matched.path,
            prompt: workspacePromptResult?.prompt ?? '',
          })
          setWorkspaceDraft(workspacePromptResult?.prompt ?? '')
          setSessionDraft(sessionPromptResult?.prompt ?? '')
          setLoaded(true)
          setDenials(Array.isArray(denialResult?.items) ? denialResult.items : [])
        } catch (_error) {
          say('failed')
        } finally {
          setBusy(false)
        }
      }, [api, sessionId, scope])

      /**
       * 手动指定工作区路径（cwd 反查失败时的兜底）。
       *
       * 只把路径填进 `workspace`，并立刻读该路径已有的提示词——这样即使会话
       * cwd 拿不到，用户仍能编辑"某个工作区"的档，而不是对着灰框无路可走。
       */
      const pickWorkspacePath = async (path) => {
        if (api === null) return
        const chosen = String(path ?? '').trim()
        if (chosen === '') return
        setBusy(true)
        try {
          const result = unwrapRemote(await api.readWorkspacePrompt(chosen))
          setWorkspace({ name: result?.name ?? null, path: chosen, prompt: result?.prompt ?? '' })
          setWorkspaceDraft(result?.prompt ?? '')
          setLoaded(true)
        } catch (_error) {
          say('failed')
        } finally {
          setBusy(false)
        }
      }

      /**
       * 触发加载：**依赖原始值，不依赖 `refresh` 的函数引用**。
       *
       * ## 为什么不用 `useEffect(() => void refresh(), [refresh])`
       *
       * `refresh` 是 `useCallback([api, sessionId, scope])`，它的引用由 React
       * 的比较决定；而 `api` 又是从 `channel` 派生的对象。这条"引用链"一旦在
       * 某个时序上没变化（例如通道先 resolve、effect 已用旧 `refresh` 跑过一次，
       * 而那次 `api` 仍是 `null` 直接早退），就会**漏掉本该发生的那次加载**——
       * 表现为“页签打开是空的，手动切换 scope 才读出内容”（切换会改 `scope`，
       * 从而撞对一次重跑）。
       *
       * 改成依赖 `[api, sessionId, scope]` 这些**原始值**，通过 ref 调最新实现：
       * 通道一就绪、会话一变化、scope 一切换，都必然跑一次，不依赖引用比较的时机。
       */
      const refreshRef = React.useRef(refresh)
      refreshRef.current = refresh
      React.useEffect(() => {
        if (api === null) return
        void refreshRef.current()
      }, [api, sessionId, scope])

      /**
       * 判一个写操作的信封是否成功。
       *
       * 外层 `ok` 表示"调用到达了 Host"，内层 `value.ok` 才是"文件真的写了"。
       * 两层都要看——只看外层会把"Host 报错但调用成功"当成保存成功。
       */
      const writeAccepted = (envelope) => {
        const value = unwrapRemote(envelope)
        if (value === null) return false
        return value?.ok !== false
      }

      /** 保存会话档。空串等于删除该档（与设置页一致）。 */
      const saveSession = async () => {
        if (api === null) return
        const seq = (seqRef.current += 1)
        setNotice(null)
        setBusy(true)
        try {
          const accepted = writeAccepted(await api.writeSession(sessionId, sessionDraft))
          setNotice({ kind: accepted ? (sessionDraft.trim() === '' ? 'removed' : 'saved') : 'failed', seq })
        } catch (_error) {
          setNotice({ kind: 'failed', seq })
        } finally {
          setBusy(false)
        }
      }

      /** 保存工作区档。没有匹配路径时按钮不可用（不能凭空建一个无主的档）。 */
      const saveWorkspace = async () => {
        if (api === null || workspace.path === null) return
        const seq = (seqRef.current += 1)
        setNotice(null)
        setBusy(true)
        try {
          const accepted = writeAccepted(await api.writeWorkspace(workspace.path, workspaceDraft))
          setNotice({ kind: accepted ? (workspaceDraft.trim() === '' ? 'removed' : 'saved') : 'failed', seq })
          if (accepted) await refresh()
        } catch (_error) {
          setNotice({ kind: 'failed', seq })
        } finally {
          setBusy(false)
        }
      }

      /**
       * 把一条拒绝理由追加成提示词草稿。
       *
       * 刻意**不**直接保存：审查理由原文是"为什么拒绝"，不是"允许什么"。
       * 直接落盘会把禁止性描述当成授权提示词，反而可能误导审查器。
       * 所以只把骨架填进草稿，由用户改成正向表述后再保存。
       *
       * 目标框跟随当前 `scope`：看本会话记录时追加到会话档，
       * 看本工作区记录时追加到工作区档——避免"看着 A 却改到 B"。
       */
      const appendDenial = (item) => {
        const reason = typeof item.reason === 'string' ? item.reason.replace(/^Auto review (denied|of) tool[^:]*:\s*/i, '') : ''
        const tool = item.tool ?? 'tool'
        const line = `${t('appendPrefix')}${tool} 可以执行这类操作 —— 依据：${reason}`
        const apply = (previous) => (previous.trim() === '' ? line : `${previous.trim()}\n${line}`)
        if (scope === 'workspace') setWorkspaceDraft(apply)
        else setSessionDraft(apply)
      }

      if (channel !== null && channel.error !== null) {
        return h(
          'div',
          { className: 'arc-tab' },
          h('div', { className: 'arc-tab-title' }, t('tabTitle')),
          h('div', { className: 'arc-hint', style: { color: 'var(--dsw-alias-state-error-primary)' } }, channel.error),
          h(
            'div',
            { className: 'arc-tab-toolbar' },
            h(
              'button',
              {
                type: 'button',
                className: 'arc-btn',
                onClick: () => {
                  // 失败不缓存（见 mountPromptRemote）；递增计数让挂载 effect 重跑。
                  setChannel(null)
                  setLoaded(false)
                  setMountAttempt((n) => n + 1)
                },
              },
              t('retryChannel'),
            ),
          ),
        )
      }

      const disabled = api === null || !loaded || !autoEnabled

      return h(
        'div',
        { className: 'arc-tab' },
        h(
          'div',
          { className: 'arc-tab-head' },
          h('div', { className: 'arc-tab-title' }, t('tabTitle')),
          h(
            'div',
            { className: 'arc-tab-desc' },
            `${t('cwdLabel')}: ${workspace.path ?? '—'}${preset === null ? '' : ` · ${preset}`}`,
          ),
        ),

        // 通道状态：必须**明确可见**，否则"未就绪"和"没有数据"在界面上无法区分
        // （2026-10-25 那次排查就卡在这里）。
        channel === null
          ? h('div', { className: 'arc-hint' }, t('channelConnecting'))
          : api === null
            ? h('div', { className: 'arc-hint' }, t('channelNotReady'))
            : loaded
              ? null
              : h('div', { className: 'arc-hint' }, t('channelLoadingData')),

        // 非 auto 预设：明确说明审查器没在跑，而不是让人对着灰框猜。
        autoEnabled
          ? null
          : h('div', { className: 'arc-hint', style: { color: 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary))' } }, t('autoOnlyHint')),

        notice !== null
          ? h(
              'div',
              {
                className: 'arc-banner',
                role: 'status',
                'data-tone': notice.kind === 'failed' ? 'error' : 'success',
                key: notice.seq,
              },
              h('span', { className: 'arc-banner-mark' }, notice.kind === 'failed' ? '✕' : '✓'),
              h('span', null, t(notice.kind)),
            )
          : null,

        // ── 当前工作区提示词 ────────────────────────────────────────────
        h(
          'div',
          { className: 'arc-tab-section' },
          h(
            'div',
            { className: 'arc-tab-subtitle' },
            h('span', null, t('workspacePromptTitle')),
            h('span', { className: 'arc-denial-meta' }, workspace.path ?? '—'),
          ),
          h('div', { className: 'arc-tab-desc' }, t('workspacePromptDescription')),
          // cwd 反查不到时给出**可操作**的兜底，而不是只显示一句“无匹配”把人堵死。
          workspace.path === null
            ? h(
                'div',
                { className: 'arc-tab-section' },
                h('div', { className: 'arc-hint' }, t('workspaceNoMatch')),
                registeredWorkspaces.length > 0
                  ? h(
                      'select',
                      {
                        className: 'arc-select',
                        value: '',
                        disabled: api === null || busy,
                        onChange: (event) => {
                          if (event.target.value !== '') void pickWorkspacePath(event.target.value)
                        },
                      },
                      h('option', { value: '' }, t('pickWorkspaceFallback')),
                      ...registeredWorkspaces.map((entry) =>
                        h(
                          'option',
                          { key: entry.id || entry.path, value: entry.path },
                          entry.title === '' ? entry.path : `${entry.title} — ${entry.path}`,
                        ),
                      ),
                    )
                  : null,
              )
            : h(
                'div',
                { className: 'arc-hint' },
                workspace.name === null ? t('workspaceNoPromptYet') : `${t('scopeWorkspace')}: ${workspace.name}`,
              ),
          h('textarea', {
            className: 'arc-textarea',
            value: workspaceDraft,
            disabled: disabled || busy || workspace.path === null,
            placeholder: t('workspacePromptPlaceholder'),
            onChange: (event) => setWorkspaceDraft(event.target.value),
          }),
          h(
            'div',
            { className: 'arc-tab-toolbar' },
            h(
              'button',
              {
                type: 'button',
                className: 'arc-btn arc-btn-primary',
                disabled: disabled || workspace.path === null,
                onClick: saveWorkspace,
              },
              t('save'),
            ),
          ),
        ),

        // ── 当前会话提示词 ──────────────────────────────────────────────
        h(
          'div',
          { className: 'arc-tab-section' },
          h(
            'div',
            { className: 'arc-tab-subtitle' },
            h('span', null, t('sessionPromptTitle')),
            h('span', { className: 'arc-denial-meta' }, sessionId),
          ),
          h('div', { className: 'arc-tab-desc' }, t('sessionPromptDescription')),
          h('textarea', {
            className: 'arc-textarea',
            value: sessionDraft,
            disabled: disabled || busy,
            placeholder: t('sessionPromptPlaceholder'),
            onChange: (event) => setSessionDraft(event.target.value),
          }),
          h(
            'div',
            { className: 'arc-tab-toolbar' },
            h(
              'button',
              {
                type: 'button',
                className: 'arc-btn arc-btn-primary',
                disabled,
                onClick: saveSession,
              },
              t('save'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'arc-btn',
                disabled: api === null,
                onClick: () => void refresh(),
              },
              t('refresh'),
            ),
          ),
        ),

        // ── 拒绝记录（本会话 / 本工作区 / 全部）─────────────────────────
        h(
          'div',
          { className: 'arc-tab-section' },
          h(
            'div',
            { className: 'arc-tab-subtitle' },
            h('span', null, t('denialsTitle')),
            h(
              'select',
              {
                className: 'arc-select',
                value: scope,
                onChange: (event) => setScope(event.target.value),
              },
              h('option', { value: 'session' }, t('denialsThisSession')),
              h('option', { value: 'workspace' }, t('denialsThisWorkspace')),
              h('option', { value: 'all' }, t('denialsAll')),
            ),
          ),
          h('div', { className: 'arc-tab-desc' }, t('denialsDescription')),

          denials.length === 0
            ? h('div', { className: 'arc-hint' }, t('denialsEmpty'))
            : h(
                'div',
                { className: 'arc-denial-list' },
                ...denials.map((item, index) =>
                  h(
                    'div',
                    { className: 'arc-denial', key: `${item.t ?? ''}-${index}` },
                    h(
                      'div',
                      { className: 'arc-denial-top' },
                      h(
                        'span',
                        { className: 'arc-denial-kind', 'data-kind': item.kind ?? 'deny' },
                        item.kind ?? 'deny',
                      ),
                      h('span', { className: 'arc-denial-meta' }, `${item.tool ?? '?'} · ${formatTime(item.t)}`),
                    ),
                    h('div', { className: 'arc-denial-reason' }, String(item.reason ?? '')),
                    item.arg ? h('div', { className: 'arc-denial-arg' }, String(item.arg)) : null,
                    h(
                      'div',
                      { className: 'arc-denial-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'arc-btn arc-btn-sm',
                          disabled,
                          onClick: () => appendDenial(item),
                        },
                        t('appendAsPrompt'),
                      ),
                    ),
                  ),
                ),
              ),
        ),

        h('div', { className: 'arc-hint' }, t('constraintNote')),
      )
    }

    /** ISO 时间压成 `HH:mm`；解析不了就原样返回。 */
    function formatTime(value) {
      if (typeof value !== 'string') return '?'
      const at = Date.parse(value)
      if (!Number.isFinite(at)) return value
      const date = new Date(at)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** 页签标题（chip 上显示的字）。 */
    function SessionTabTitle(props) {
      const { t } = props
      return h('span', null, t('tabTitle'))
    }

    /**
     * 会话标题旁的入口按钮。
     *
     * ## 只在 Auto review 预设下出现
     *
     * 这个页签的全部内容（审查提示词、拒绝记录）只有在审查器真的在跑时才有意义。
     * `useProjection('permissions')` 给出 `{ currentValue }`；不是 `auto` 就返回
     * `null`，按钮整个不渲染——比"渲染出来但点了没用"干净。
     *
     * 投影还没到达时（`undefined`）**按可见处理**：宿主可能在会话刚建好时短暂
     * 没有该帧，此时隐藏会让按钮闪一下。宁可短暂多显示，也不要闪烁。
     *
     * 样式刻意贴宿主的小按钮规格（`arc-btn-sm`），不要在这加图标依赖：
     * 客户端半区不能 import `@deepseek-ai/dsh-client-ui-primitives`。
     *
     * @param {object} props
     */
    function SessionHeaderAction(props) {
      const { t, openSessionTab, useProjection } = props

      const permissions = useProjection('permissions')
      const preset = typeof permissions?.currentValue === 'string' ? permissions.currentValue : null
      if (preset !== null && preset !== 'auto') return null

      return h(
        'button',
        {
          type: 'button',
          className: 'arc-btn arc-btn-sm',
          title: t('tabGuideDescription'),
          onClick: () => openSessionTab(),
        },
        t('tabTitle'),
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

        // ⚠️ 超时保护：`$mount` 走 gateway 的全局串行 mutation 队列，历史上有过
        // 挂起不 settle 的情况（队列被启动期的内置命名空间占住）。不设超时的话，
        // 页签会永远停在"未就绪"，而且**看起来像数据为空**——这正是 2026-10-25
        // 那次"目录显示 —、输入框全灰"的排查盲区。超时后给出明确错误，可重试。
        let timer = null
        const timeout = new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ api: null, error: `$mount 超时（${MOUNT_TIMEOUT_MS}ms 未返回）——Remote 网关队列可能被占用，重新打开页签可重试` }),
            MOUNT_TIMEOUT_MS,
          )
        })

        const mountTask = (async () => {
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

        const settled = await Promise.race([mountTask, timeout])
        if (timer !== null) clearTimeout(timer)
        if (settled.api === null) {
          // 失败/超时**不要**缓存：下次打开页签还能重试，否则一次抖动永久坏掉。
          promptMount = null
        }
        return settled
      })()

      return promptMount
    }

    return {
      /**
       * 顶层依赖 —— **只列必需且普遍存在的服务**。
       *
       * ⚠️ 绝对不要把 `sidebarRightTabs` / `sidebarRight` 放进来：
       * cordis 的注入是强制的，顶层 inject 里有一个缺失服务，整个插件 fiber
       * 判 INACTIVE、`apply` 一行不跑（实测见下方子插件注释）。右栏只在部分
       * 构建里存在，放这里会让**设置页**跟着一起消失。
       */
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

        /**
         * 本地化取词器。
         *
         * `ctx.locale.bind(ns)` 返回的函数会跟随当前语言；页签类型里的
         * `title` / `guide[].title` 是**每次用到时重新调用**的 thunk，
         * 所以把它们绑到同一个取词器上，切换语言不需要重新注册。
         */
        const t = ctx.locale.bind(LOCALE_NS)
        const localeRef = { t: (key) => t(key) }

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

        // ── 会话页签（右栏）：注册成一个**显式命名的子插件** ───────────
        //
        // ## 依赖隔离（必须如此）
        //
        // `sidebarRightTabs` / `sidebarRight` 只在装了右栏的构建里存在，属**可选**。
        // 而 cordis 的注入是**强制**语义：顶层 `inject` 里列了缺失的服务，整个插件
        // fiber 直接判 INACTIVE，`apply` 一行都不跑。实测：
        //
        //   inject:['slots']                    + slots 存在  → 应用了
        //   inject:['slots','sidebarRightTabs'] + 后者缺失    → 未应用（整插件不跑）
        //
        // 所以这两个服务**绝不能**写进本插件顶层 `inject`（否则没右栏的构建里
        // 设置页会跟着消失），只能交给子插件声明：子插件缺依赖只让自己不激活，
        // 父插件的设置页照常工作；右栏服务晚到（热重载/延迟挂载）时 cordis 会自动
        // 把子插件拉起来。
        //
        // 用 `ctx.plugin({name,...})` 而非 `ctx.inject([...], cb)`：两者语义等价
        // （`ctx.inject` 内部就是 `plugin({inject,apply})`），但前者能给子插件一个
        // **可读名字**，cordis 的 fiber 诊断里能直接看出这是本插件的哪一部分。
        //
        // 两阶段注册，缺一不可（`ui-sidebar-right/README.md`「Extension seats」）：
        //   1. `sidebarRightTabs.register` 声明这个类型**是什么**；
        //   2. `slots.register('sidebar.right.pane.tab', { key: id })` 提供**正文**，
        //      以及可选的 `sidebar.right.pane.tab.title` 提供 chip 上的活标题。
        ctx.plugin({
          name: 'auto-review-custom/right-tab',
          inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
          apply(tabsCtx) {
            /** 打开页签：右栏会自己展开（"content the user cannot see is not opened"）。 */
            const openSessionTab = () => {
              try {
                tabsCtx.sidebarRight.openTab(SESSION_TAB_KIND, { revealIfOpened: true })
              } catch (error) {
                console?.warn?.(`[auto-review-custom] 打开会话页签失败：${String(error?.message ?? error)}`)
              }
            }

            tabsCtx.effect(
              () =>
                tabsCtx.sidebarRightTabs.register({
                  id: SESSION_TAB_ID,
                  kind: SESSION_TAB_KIND,
                  priority: 'extension',
                  // 标题在开页签时捕获一次；活标题由下面的 title 注册提供。
                  title: () => localeRef.t('sessionDefaultTitle'),
                  guide: [
                    {
                      id: 'open',
                      order: 10,
                      title: () => localeRef.t('tabGuideTitle'),
                      description: () => localeRef.t('tabGuideDescription'),
                    },
                  ],
                }),
              'auto-review-custom session tab type',
            )

            tabsCtx.effect(
              () =>
                tabsCtx.slots.inject('sidebar.right.pane.tab', () =>
                  tabsCtx.slots.register(
                    {
                      name: 'sidebar.right.pane.tab',
                      key: SESSION_TAB_ID,
                      locale: LOCALE_NS,
                      inject: () => ({ loadPromptApi: () => mountPromptRemote(ctx) }),
                    },
                    SessionTab,
                  ),
                ),
              'auto-review-custom session tab body',
            )

            tabsCtx.effect(
              () =>
                tabsCtx.slots.inject('sidebar.right.pane.tab.title', () =>
                  tabsCtx.slots.register(
                    { name: 'sidebar.right.pane.tab.title', key: SESSION_TAB_ID, locale: LOCALE_NS },
                    SessionTabTitle,
                  ),
                ),
              'auto-review-custom session tab title',
            )

            // ── 打开入口：会话标题旁的一个按钮 ────────────────────────
            //
            // 只靠右栏的 guide 卡片入口不够显眼（用户得先展开右栏、再找指南页）。
            // `conversation.session.header.actions` 是会话标题旁的加分位，
            // 点一下直接 `openTab(kind)`——右栏会自己展开。
            tabsCtx.effect(
              () =>
                tabsCtx.slots.inject('conversation.session.header.actions', () =>
                  tabsCtx.slots.register(
                    {
                      name: 'conversation.session.header.actions',
                      id: 'auto-review-custom.session-prompt',
                      order: 60,
                      label: () => localeRef.t('tabTitle'),
                      locale: LOCALE_NS,
                      inject: () => ({ openSessionTab }),
                    },
                    SessionHeaderAction,
                  ),
                ),
              'auto-review-custom session header action',
            )
          },
        })
      },
    }
  },
})
