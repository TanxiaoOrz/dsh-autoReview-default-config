/**
 * 版本适配声明：把"我们依赖宿主的哪些内部事实"变成一份**可校验的清单**。
 *
 * ## 为什么需要这个文件
 *
 * 本插件的核心能力建立在三个宿主内部事实上：
 *
 *   1. 审查器（@deepseek-ai/dsh-experimental-auto-review）把它的 system prompt
 *      写成一段以 `REVIEW_POLICY` 开头的固定文本——这是我们**唯一**能识别
 *      "这个 LLM 请求是审查请求"的依据。
 *   2. 审查器把待审查动作渲染成 `ENVIRONMENT / PROJECT_INSTRUCTIONS /
 *      FILTERED_HISTORY / PENDING_ACTION` 四段——我们靠 `PROJECT_INSTRUCTIONS`
 *      这个锚点把自定义提示词插进去。
 *   3. 审查器的 `readDecision()` 只接受"零或多个 reasoning 块 + 恰好一个
 *      text 块 + 终止 finish(stop)"的流——放行规则伪造的 allow 流必须严格符合。
 *
 * 这三个事实都是**厂商内部实现细节**，不是公开契约。厂商任何一次升级都可能
 * 改动它们，而改动的方式通常是"静默失效"（插件不报错、就是不工作），
 * 这比直接崩溃更难发现。
 *
 * 所以：把事实写成常量，运行时比对，不匹配就**明确告警并降级**，
 * 升级后由 `scripts/check-compat.mjs` 做源码校验，不兼容则发新版。
 * 维护流程见 VERSIONS.md。
 *
 * @module dsh-auto-review-custom/compat
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** 本插件适配的宿主版本区间（package.json 里的 peer range 也写这里，两处必须一致）。 */
export const SUPPORTED_HOST_VERSION = '0.2.0-rc.2'

/** 适配的上下文：每个我们依赖的厂商包，及其被验证过的版本。 */
export const VERIFIED_PACKAGES = Object.freeze({
  // 功能①②③ 的判定基础
  '@deepseek-ai/dsh-experimental-auto-review': '0.2.0-rc.2',
  '@deepseek-ai/dsh-permission-presets': '0.2.0-rc.2',
  '@deepseek-ai/dsh-llm': '0.2.0-rc.2',
  '@deepseek-ai/dsh-session': '0.2.0-rc.2',
  '@deepseek-ai/dsh-workspace': '0.2.0-rc.2',
  // 设置页与提示词文件通道（F5–F9）
  '@deepseek-ai/dsh-api-gateway': '0.2.0-rc.2',
  '@deepseek-ai/dsh-typert-protocol': '0.2.0-rc.2',
  '@deepseek-ai/dsh-typert-registry': '0.2.0-rc.2',
  '@deepseek-ai/dsh-client-ui-settings': '0.2.0-rc.2',
})

/**
 * 审查请求的 system 指纹。
 *
 * 取 REVIEW_POLICY 的开头（原文第一行 `REVIEW_POLICY` + 第二行开头），
 * 共 47 个 ASCII 字符。**故意只取开头**：厂商改动正文中段（改措辞、加规则）
 * 不该让我们的识别失效；只有改动"开头标识"才是真正的破坏性变更。
 */
export const REVIEW_SYSTEM_FINGERPRINT = 'REVIEW_POLICY\nYou are the final authorization reviewer'

/** 审查请求 user 消息里，可供我们插入自定义提示词的段锚点。 */
export const PROJECT_INSTRUCTIONS_ANCHOR = 'PROJECT_INSTRUCTIONS'

/** 审查请求 user 消息的完整段顺序（用于校验锚点位置是否仍然可信）。 */
export const REVIEW_SECTIONS = Object.freeze([
  'ENVIRONMENT',
  'PROJECT_INSTRUCTIONS',
  'FILTERED_HISTORY',
  'PENDING_ACTION',
])

/**
 * 判断一个 LLM 请求是否是一次 auto review 审查请求。
 *
 * 判定是**保守**的：三条同时满足才算，任何一条不确定都返回 false（当作普通请求透传）。
 * 宁可漏认（提示词不生效，可被 doctor 发现），也绝不误认（污染主对话）。
 *
 * @param {unknown} options - `llm/stream` 收到的 GenerateOptions。
 * @returns {boolean}
 */
export function isReviewRequest(options) {
  if (options === null || typeof options !== 'object') return false
  const { system, messages } = /** @type {Record<string, unknown>} */ (options)

  // 事实 1：审查器用 system 字段承载 REVIEW_POLICY；loop 构建的主对话请求
  // 把 system prompt 放在 messages[0]，这里的 system 是 undefined。
  if (typeof system !== 'string') return false
  if (!system.startsWith(REVIEW_SYSTEM_FINGERPRINT)) return false

  // 审查器恰好发一条 user 消息。主对话必然是多条消息。
  if (!Array.isArray(messages) || messages.length !== 1) return false

  const only = messages[0]
  if (only === null || typeof only !== 'object') return false
  if (/** @type {Record<string, unknown>} */ (only).role !== 'user') return false

  // 事实 2：user 消息里必须能找到三个段锚点（PROJECT_INSTRUCTIONS 是我们要改的，
  // 另外两个用来确认段落结构没被改版）。
  const text = userMessageText(only)
  if (text === null) return false
  if (!text.includes(PROJECT_INSTRUCTIONS_ANCHOR)) return false
  if (!text.includes('PENDING_ACTION')) return false

  return true
}

/**
 * 取一条 user 消息的第一段 text 内容；结构不符合预期时返回 null。
 *
 * @param {unknown} message - 一条 RequestMessage。
 * @returns {string | null}
 */
export function userMessageText(message) {
  if (message === null || typeof message !== 'object') return null
  const content = /** @type {Record<string, unknown>} */ (message).content
  if (!Array.isArray(content) || content.length === 0) return null
  const first = content[0]
  if (first === null || typeof first !== 'object') return null
  const record = /** @type {Record<string, unknown>} */ (first)
  if (record.type !== 'text' || typeof record.text !== 'string') return null
  return record.text
}

/**
 * 把自定义提示词插进审查请求的 PROJECT_INSTRUCTIONS 段。
 *
 * 做法：定位 `PROJECT_INSTRUCTIONS\n\n<json>`，把 `<json>` 解析成数组后
 * **追加**一个 constraint 条目。**不重建整段文本**——只改数组内容，
 * 这样即使厂商改了别的段（EFFORT / 新增段），我们也只碰自己那一格。
 *
 * @param {string} text - 原始 user 消息文本。
 * @param {string} prompt - 要追加的自然语言提示词。
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function injectPromptIntoReviewText(text, prompt) {
  const anchorAt = text.indexOf(`\n\n${PROJECT_INSTRUCTIONS_ANCHOR}\n\n`)
  if (anchorAt < 0) return { ok: false, reason: `找不到 ${PROJECT_INSTRUCTIONS_ANCHOR} 段锚点` }

  const jsonStart = anchorAt + `\n\n${PROJECT_INSTRUCTIONS_ANCHOR}\n\n`.length
  const nextSectionAt = text.indexOf('\n\nFILTERED_HISTORY\n\n', jsonStart)
  if (nextSectionAt < 0) return { ok: false, reason: '找不到 FILTERED_HISTORY 段锚点（段结构可能已改版）' }

  const rawJson = text.slice(jsonStart, nextSectionAt)
  let items
  try {
    items = JSON.parse(rawJson)
  } catch (error) {
    return { ok: false, reason: `PROJECT_INSTRUCTIONS 段不是合法 JSON：${String(error?.message ?? error)}` }
  }
  if (!Array.isArray(items)) return { ok: false, reason: 'PROJECT_INSTRUCTIONS 段不是数组' }

  // 形状对齐审查器自己的 constraint 条目（见 auto-review 的 isProjectInstruction 分支）：
  // { kind: 'user-message', role: 'constraint', source, content: [textBlock] }。
  // role 必须是 constraint —— REVIEW_POLICY 明文规定"constraint 只能收窄"，这正是我们想要的语义。
  items.push({
    kind: 'user-message',
    role: 'constraint',
    source: { kind: 'auto-review-custom', form: 'instructions' },
    content: [{ type: 'text', text: prompt }],
  })

  const rebuilt = JSON.stringify(items, null, 2)
  return { ok: true, text: text.slice(0, jsonStart) + rebuilt + text.slice(nextSectionAt) }
}

/**
 * 找出**当前进程真正运行的那套 DSH** 的 `@deepseek-ai` 目录。
 *
 * ## 为什么不能直接 `import('@deepseek-ai/dsh-llm')`
 *
 * 因为会解析到**错的地方**。实测：这样拿到的版本是 `0.1.5-rc.3`——那是
 * `profiles/<profile>/node_modules/@deepseek-ai/` 里的**陈旧副本**；
 * 而进程实际跑的是安装目录里的 `0.2.0-rc.2`。
 * 用陈旧副本做版本比对，会在完全健康的安装上**误报**。
 *
 * 可靠锚点是**进程自身的入口路径**：
 *
 * ```
 * process.argv[1] = <root>/node_modules/@deepseek-ai/dsh/lib/bin.js
 *                                          ↑ 上溯 3 层就是 scope 目录
 * ```
 *
 * @returns {string | null}
 */
function harnessScopeDir() {
  try {
    const entry = process.argv?.[1]
    if (typeof entry !== 'string' || entry.length === 0) return null
    // <scope>/dsh/lib/bin.js → <scope>
    return dirname(dirname(dirname(entry))).replace(/[\\/]+$/, '')
  } catch {
    return null
  }
}

/**
 * 读当前运行体里某个 `@deepseek-ai/*` 包的 `package.json`。
 *
 * @param {string} scope - `harnessScopeDir()` 的结果。
 * @param {string} pkg - 完整包名，如 `@deepseek-ai/dsh`。
 * @returns {any | null}
 */
function readScopedPackage(scope, pkg) {
  const bare = pkg.startsWith('@deepseek-ai/') ? pkg.slice('@deepseek-ai/'.length) : pkg
  const candidate = join(scope, bare, 'package.json')
  if (!existsSync(candidate)) return null
  try {
    return JSON.parse(readFileSync(candidate, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 检测当前运行体的宿主版本。
 *
 * 以 `@deepseek-ai/dsh`（CLI 包）的 `version` 为准——它和所有 `@deepseek-ai/*`
 * 出自同一次发布，比逐个包解析更稳，也不会被 profile 里的陈旧副本误导。
 *
 * @returns {{ version: string | null, packages: Record<string, string> }}
 */
export function detectHarnessVersion() {
  /** @type {Record<string, string>} */
  const packages = {}
  const scope = harnessScopeDir()
  if (scope === null) return { version: null, packages }

  const own = readScopedPackage(scope, '@deepseek-ai/dsh')
  const version = typeof own?.version === 'string' ? own.version : null

  // 附带收集几个关键包版本，只用于诊断输出（不参与判定）。
  for (const spec of Object.keys(VERIFIED_PACKAGES)) {
    const pkg = readScopedPackage(scope, spec)
    if (typeof pkg?.version === 'string') packages[spec] = pkg.version
  }

  return { version, packages }
}

/**
 * 比对运行时宿主版本与适配版本。
 *
 * 只在**能确定版本且不一致**时判为 `mismatch`；拿不到版本时返回 `unknown`，
 * 由调用方决定怎么处理（本插件选择"不告警"，避免在非常规启动方式下误报）。
 *
 * @returns {{
 *   status: 'ok' | 'mismatch' | 'unknown',
 *   actual: string | null,
 *   expected: string,
 *   packages: Record<string, string>,
 * }}
 */
export function checkHostVersions() {
  const detected = detectHarnessVersion()
  const expected = SUPPORTED_HOST_VERSION
  if (detected.version === null) {
    return { status: 'unknown', actual: null, expected, packages: detected.packages }
  }
  return {
    status: detected.version === expected ? 'ok' : 'mismatch',
    actual: detected.version,
    expected,
    packages: detected.packages,
  }
}


