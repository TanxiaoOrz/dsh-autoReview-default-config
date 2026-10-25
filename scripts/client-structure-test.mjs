/**
 * 设置页客户端的结构性检查（不启动浏览器）。
 *
 * 运行：node scripts/client-structure-test.mjs
 */

import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0

function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function heading(text) {
  console.log(`\n[${text}]`)
}

heading('加载契约')
check('使用模块加载器', src.includes('__ModuleLoader__.load'))
check('模块 id 等于包名', src.includes("id: 'dsh-auto-review-custom'"))
check('apply 保持同步（不在启动阶段挂载）', !src.includes('async apply(ctx)'))
check('不再在 apply 里 await', !/apply\(ctx\)\s*\{[^}]{0,600}\bawait\b/.test(src.split('apply(ctx)')[1]?.slice(0, 600) ?? ''))

heading('Remote 通道')
check('惰性挂载函数存在', src.includes('function mountPromptRemote(ctx)'))
check('挂载单例（只挂一次）', src.includes('let promptMount = null') && src.includes('if (promptMount !== null) return promptMount'))
check('解包返回信封', src.includes('function unwrapRemote'))
check('read 使用解包', src.includes('unwrapRemote(envelope)'))
check('失败可读化', src.includes('function describeRemoteFailure'))

heading('目录选择器')
check('接入了 uiWorkspace', src.includes("ctx.get?.('uiWorkspace')"))
check('调用 pickDirectory', src.includes('workspace.pickDirectory()'))
check('有选择按钮文案', src.includes('选择目录') && src.includes('Browse'))
check('不可用时有说明', src.includes('browseUnavailable'))

heading('工作区路径的三种填法')
check('客户端描述符 10 条', (src.match(/descriptor\('/g) ?? []).length === 10)
check('含 listWorkspaces 描述符', src.includes("descriptor('listWorkspaces', [])"))
check('含会话档描述符', src.includes("descriptor('readSession', ['sessionId'])") && src.includes("descriptor('writeSession', ['sessionId', 'text'])"))
check('含会话上下文描述符', src.includes("descriptor('readSessionContext', ['sessionId'])") && src.includes("descriptor('readWorkspacePrompt', ['workspacePath'])"))
check('含拒绝查询描述符', src.includes("objectDescriptor('queryDenials', 'filter')"))
check('调用 listWorkspaces', src.includes('promptApi.listWorkspaces()'))
check('下拉 select 存在', src.includes("'select',"))
check('下拉文案中英齐全', src.includes('从已注册工作区选择') && src.includes('Pick a registered workspace'))
check('仍保留浏览按钮', src.includes('onClick: browse'))
check('仍保留手输框', src.includes("placeholder: t('workspacePathPlaceholder')"))

heading('保存反馈')
check('横幅组件样式存在', src.includes('.arc-banner'))
// 注意：`sectionPermission` 在文案字典里也会出现，所以要用渲染期才有的写法定位。
const bannerAt = src.indexOf("className: 'arc-banner'")
const permissionAt = src.indexOf("t('sectionPermission')")
check(
  '横幅渲染在权限段之前',
  bannerAt !== -1 && permissionAt !== -1 && bannerAt < permissionAt,
  `banner=${bannerAt} permission=${permissionAt}`,
)
check('横幅有 role=status', src.includes("role: 'status'"))
check('用 seq 强制重新计时', src.includes('seqRef.current += 1') && src.includes('key: notice.seq'))
check('不再按内容相等禁用保存', !src.includes('globalDraft === storedGlobal,') && !src.includes('draft === entry.prompt,'))
check('显示 3.5 秒', src.includes('3500'))

heading('开关取值映射（0.1.0 的「保存失败」回归）')
// 背景：开关只产出布尔值，而 defaultPreset 在 Config schema 里是
// z.union(['auto','off'])。0.1.0 把 true 原样提交，被宿主拒绝：
//   ValidationError: $.defaultPreset expected "auto" | "off" but got true
check('存在开关取值映射表', src.includes('BOOLEAN_FIELD_VALUES'))
check('defaultPreset 映射到 auto/off', /defaultPreset:\s*\{\s*on:\s*'auto',\s*off:\s*'off'\s*\}/.test(src))
check('toggle 经 fieldValue 转换后再提交', src.includes('setField(field, fieldValue(field, next))'))
check('toggle 不再原样透传布尔值', !src.includes('setField(field, next)'))
// schema 里的联合字段必须都登记进映射表，否则同一个 bug 会在新字段上复发。
// 判定方式：按顶层字段切块，块内含 `.union(` 的即为非布尔（联合）字段。
const schemaSrc = readFileSync(new URL('../lib/schema.js', import.meta.url), 'utf8')
const unionFields = [...schemaSrc.matchAll(/^ {2}(\w+): z([\s\S]*?)(?=^ {2}\w+: z|^\})/gm)]
  .filter((match) => match[2].includes('.union('))
  .map((match) => match[1])
check('识别到 schema 中的联合字段', unionFields.length > 0, `找到 ${unionFields.length} 个`)
for (const field of unionFields) {
  check(`联合字段 ${field} 已登记取值映射`, src.includes(`${field}: {`))
}

heading('样式约束')
check('无硬编码颜色', !/#[0-9a-f]{3,8}\b/i.test(src))
check('只用主题 token', src.includes('--dsw-alias-'))
check('中英文案齐全', src.includes('已保存') && src.includes('Prompt saved'))

heading('注入隔离：右栏缺失不得拖垮设置页')
// 背景：cordis 的注入是**强制**语义 —— 顶层 inject 里列了缺失的服务，整个插件
// fiber 直接判 INACTIVE、apply 一行不跑。右栏只在部分构建里有，若把它写进顶层，
// 没装右栏的构建里**设置页会跟着一起消失**（这是必须防住的架构回归）。
// 实测：inject:['slots','sidebarRightTabs'] 且后者缺失 → 插件不执行；
//       inject:['slots']（右栏依赖交给子插件）→ 父插件照常应用。
const TOP_INJECT = /inject:\s*\[([^\]]*)\]/
const firstInjectMatch = TOP_INJECT.exec(src)
const firstInject = firstInjectMatch ? firstInjectMatch[1] : ''
check('能读到插件顶层 inject', firstInjectMatch !== null, String(firstInject))
check('顶层 inject 不含 sidebarRightTabs', !firstInject.includes('sidebarRightTabs'), firstInject)
check('顶层 inject 不含 sidebarRight（单数服务）', !/\bsidebarRight\b/.test(firstInject), firstInject)
check('顶层 inject 保留 slots/locale/configForms', ['slots', 'locale', 'configForms'].every((k) => firstInject.includes(k)))
check('页签注册在独立子插件里', src.includes("name: 'auto-review-custom/right-tab'"))
const subInject = /name:\s*'auto-review-custom\/right-tab',\s*\n\s*inject:\s*\[([^\]]*)\]/.exec(src)
check('子插件自己声明右栏依赖', subInject !== null && subInject[1].includes('sidebarRightTabs') && subInject[1].includes('sidebarRight'), subInject ? subInject[1] : 'not found')
check('页签注册用 ctx.plugin 包起来', src.includes('ctx.plugin({'))

heading('AutoReview 管理页签')
check('页签名称为「AutoReview 管理」', src.includes("tabTitle: 'AutoReview 管理'"))
check('英文页签名为 AutoReview', src.includes("tabTitle: 'AutoReview'"))
check('页签 id 是包级稳定标识', src.includes("SESSION_TAB_ID = 'dsh-auto-review-custom/session-prompt'"))
check('注册 sidebar.right.pane.tab', src.includes("name: 'sidebar.right.pane.tab'"))
check('注册 pane.tab.title', src.includes("name: 'sidebar.right.pane.tab.title'"))
check('注册会话头部入口', src.includes("name: 'conversation.session.header.actions'"))
check('页签用 sidebarRightTabs.register 声明类型', src.includes('sidebarRightTabs.register('))
check('类型带 guide 入口', src.includes('guide: ['))
check('priority 为 extension', src.includes("priority: 'extension'"))

heading('页签双档：工作区 + 会话')
check('有工作区提示词编辑区', src.includes("t('workspacePromptTitle')"))
check('有会话提示词编辑区', src.includes("t('sessionPromptTitle')"))
check('保存工作区调用 writeWorkspace', src.includes('api.writeWorkspace(workspace.path, workspaceDraft)'))
check('保存会话调用 writeSession', src.includes('api.writeSession(sessionId, sessionDraft)'))
check('读取会话上下文 readSessionContext', src.includes('api.readSessionContext(sessionId)'))
check('按路径读工作区档 readWorkspacePrompt', src.includes('api.readWorkspacePrompt(matched.path)'))
check('无匹配工作区时有说明', src.includes("t('workspaceNoMatch')"))
check('cwd 未知时不死锁（可从已注册工作区挑）', src.includes('pickWorkspacePath') && src.includes("t('pickWorkspaceFallback')"))
check('兜底也走 readWorkspacePrompt', src.includes('api.readWorkspacePrompt(chosen)'))
check('页签头部显示 cwd 与预设', src.includes("t('cwdLabel')") && src.includes('workspace.path ??'))

heading('Remote 信封必须拆包（0.2.0 页签读不到数据的真因）')
// 背景：网关**总是**返回 {ok:true,value} / {ok:false,error}。不拆包时
// `context.cwd` 恒为 undefined → 「目录」显示 —、提示词读成空、拒绝记录读成空，
// 而且**不抛错**，看起来就像"通道没通"或"没有数据"。
// 设置页一直正常正是因为它每个调用都 unwrapRemote；页签首版全漏了。
{
  const tabStart = src.indexOf('function SessionTab(')
  const tabEnd = src.indexOf('/** ISO 时间压成')
  const tabBody = tabStart >= 0 && tabEnd > tabStart ? src.slice(tabStart, tabEnd) : ''
  check('能定位 SessionTab 函数体', tabBody.length > 0, `${tabBody.length} chars`)

  // 任何 `X(await api.foo(...))` 里的 X 必须是 unwrapRemote 或 writeAccepted。
  const bare = []
  for (const m of tabBody.matchAll(/(\w+)\s*\(\s*await api\.(\w+)/g)) {
    if (m[1] !== 'unwrapRemote' && m[1] !== 'writeAccepted') bare.push(`${m[2]}(by ${m[1]})`)
  }
  check('页签没有未拆包的 await api.* 调用', bare.length === 0, bare.join(', '))

  // `.then(...)` 形态也要拆。统计读取类调用的 unwrap 覆盖。
  check('readSessionContext 拆包', tabBody.includes('unwrapRemote(await api.readSessionContext('))
  check('readSession 拆包', /api\.readSession\([^)]*\)\.then\(unwrapRemote\)/.test(tabBody))
  check('queryDenials 拆包', /\.queryDenials\([\s\S]{0,500}?\)\s*\.then\(unwrapRemote\)/.test(tabBody))
  check('listWorkspaces 拆包', /api\.listWorkspaces\(\)\.then\(unwrapRemote\)/.test(tabBody))
  check('readWorkspacePrompt 拆包（兜底路径）', tabBody.includes('unwrapRemote(await api.readWorkspacePrompt('))
  check('写操作查内层 ok', tabBody.includes('writeAccepted') && tabBody.includes('value?.ok !== false'))
}

heading('自动加载（页签打开即读，不用手动切 scope）')
// 背景：0.2.0 首版 effect 依赖 `refresh` 的函数引用（useCallback 链），
// 通道就绪与 effect 跑动之间存在时序缝——那次 effect 拿到的是 api=null 的旧
// `refresh`，直接早退；之后 api 变非 null 也不保证重跑。表现：页签打开是空的，
// 手动切一次 scope 才有内容（切 scope 撞对了一次重跑）。
{
  const tabStart = src.indexOf('function SessionTab(')
  const tabEnd = src.indexOf('function formatTime(')
  const tabBody = tabStart >= 0 && tabEnd > tabStart ? src.slice(tabStart, tabEnd) : ''
  check('用 refreshRef 调最新实现', tabBody.includes('refreshRef.current = refresh'))
  check('加载 effect 依赖原始值', /void refreshRef\.current\(\)\s*\n\s*\},\s*\[api,\s*sessionId,\s*scope\]/.test(tabBody))
  check('不再依赖 refresh 函数引用', !/void refresh\(\)\s*\n\s*\},\s*\[refresh\]/.test(tabBody))
  check('通道未就绪时不空转', /if \(api === null\) return\s*\n\s*void refreshRef\.current\(\)/.test(tabBody))
}

heading('通道状态可见（未就绪 ≠ 没数据）')
check('有连接中文案', src.includes("t('channelConnecting')"))
check('有未就绪文案', src.includes("t('channelNotReady')"))
check('有加载中文案', src.includes("t('channelLoadingData')"))
check('有重试按钮', src.includes("t('retryChannel')"))
check('$mount 有超时', /MOUNT_TIMEOUT_MS\s*=\s*\d+/.test(src) && src.includes('Promise.race'))
check('失败不缓存可重试', src.includes('promptMount = null'))
check('挂载 effect 依赖重试计数', src.includes('[loadPromptApi, mountAttempt]'))

heading('拒绝记录：本会话 / 本工作区')
check('拒绝记录有三个 scope 选项', src.includes("value: 'session'") && src.includes("value: 'workspace'") && src.includes("value: 'all'"))
check('工作区 scope 用 cwd 过滤', src.includes('{ cwd, limit: 30 }'))
check('会话 scope 用 sessionId 过滤', src.includes('{ sessionId, limit: 30 }'))
check('追加目标跟随 scope', src.includes("if (scope === 'workspace') setWorkspaceDraft(apply)"))

heading('非 auto 预设时不显示（第 4 条）')
check('头部入口读 permissions 投影', /useProjection\('permissions'\)/.test(src))
check('非 auto 时入口返回 null', /preset !== null && preset !== 'auto'\)\s*return null/.test(src))
check('页签内也做 auto 门禁', src.includes('autoEnabled'))
check('非 auto 有解释文案', src.includes("t('autoOnlyHint')"))
check('autoOnlyHint 中英齐全', src.includes('没有使用 Auto review 预设') && src.includes('not using the Auto review preset'))

heading('拒绝记录排版（0.2.1）')
// 背景（2026-10-25 用户截图）：记录一多，条目长文本就溢出自己的卡片、叠到
// 下一张卡片上，看起来像"文字重影"。根因是 `.arc-tab` 是**定高 + overflow:auto**
// 的 flex 列，子项默认 flex-shrink:1 —— 内容超高时浏览器先压扁卡片而不会滚动，
// 卡片高度小于内容高度，文字就溢出到卡片外。修法是三层都显式禁止压缩。
{
  check('tab 子项禁止压缩', /\.arc-tab > \* \{ flex: 0 0 auto; \}/.test(src))
  const cardRule = /\.arc-denial \{[^}]*\}/.exec(src)?.[0] ?? ''
  check('卡片禁止压缩', cardRule.includes('flex: 0 0 auto'), cardRule.slice(0, 90))
  check('列表禁止压缩', /\.arc-denial-list \{[^}]*flex: 0 0 auto/.test(src))

  // 长文本折叠：理由 4 行、原始命令 2 行，超出给「展开」。否则一屏放不下两条。
  check('理由折叠有上限', /\.arc-denial-reason\[data-clamp="on"\] \{[^}]*max-height: 68px/.test(src))
  check('命令折叠有上限', /\.arc-denial-arg\[data-clamp="on"\] \{[^}]*max-height: 32px/.test(src))
  check('折叠有淡出提示', src.includes('mask-image: linear-gradient'))
  check('卡片拆成独立组件', src.includes('function DenialCard(') && src.includes('h(DenialCard, {'))
  check('只有长文本才给展开按钮', src.includes('clampReason || clampArg'))
  check('展开状态是页签级 Set', src.includes('expandedDenials, setExpandedDenials') && src.includes('new Set(previous)'))
  check('折叠/展开文案中英齐全', src.includes("expandDenial: '展开'") && src.includes("collapseDenial: 'Collapse'"))

  // 0.2.0 的 ask 标签用了不存在的 token 名（宿主真名是 state-warn-primary），
  // 写错后回落成淡色底 + bg-base 文字色 → 浅色主题下白字淡底、看不见。
  check('kind 用本地化文案', src.includes('DENIAL_KIND_KEYS'))
  check('没有用错的 token 名', !/var\(--dsw-alias-state-warning-primary/.test(src))
  check('ask 用宿主真实 token', src.includes('var(--dsw-alias-state-warn-label'))
  check('工具名省略号截断', /\.arc-denial-tool \{[^}]*text-overflow: ellipsis/.test(src))
  check('时间单独一格', src.includes("className: 'arc-denial-time'"))
}

console.log(`\n${'='.repeat(48)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
console.log('='.repeat(48))
process.exit(fail === 0 ? 0 : 1)
