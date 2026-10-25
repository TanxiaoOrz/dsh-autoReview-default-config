/**
 * **会话级提示词**存储（0.2.0 新增）。
 *
 * ## 为什么需要第三档
 *
 * 0.1.x 只有两档：全局 + 工作区。但"同一个工作区里，这次会话想放宽/收紧一点"
 * 是最常见的手工调整，用工作区档承担会污染其它会话，用全局档更不可能。
 *
 * ## 作用域与匹配
 *
 * | 档 | 键 | 何时生效 |
 * |---|---|---|
 * | 全局 | — | 所有审查请求 |
 * | 工作区 | 工作区绝对路径 | 审查请求的 `ENVIRONMENT.cwd` 落在其下 |
 * | **会话** | **会话 id** | 该会话发起的审查请求 |
 *
 * ## ⚠️ 关键约束：审查请求里没有 sessionId
 *
 * 审查器构造的 user 文本只有四段（`ENVIRONMENT / PROJECT_INSTRUCTIONS /
 * FILTERED_HISTORY / PENDING_ACTION`，见 auto-review 的 `reviewUserText`），
 * `ENVIRONMENT` 里只有 `cwd`。**没有会话身份**。
 *
 * 所以会话档不能靠审查请求匹配，只能靠**旁路绑定**：插件在
 * `tools/pre-execute` 里能拿到 `exec.agent.session.id`，在那里把
 * 「当前正在审查的会话」记进一个**按 cwd 隔离的作用域槽**；随后同一轮里
 * `llm/stream` 收到审查请求时，从这个槽里取出会话 id。
 *
 * 这个绑定是**有意的弱关联**：宿主是并发执行的，两个会话可能同时发审查请求。
 * 因此：
 *
 * - 槽按 cwd 隔离（不同工作区的会话互不污染）；
 * - 槽有**有效期**（默认 15s），过期视为无绑定，宁可不注入也不串会话；
 * - 同一 cwd 下以**最近一次** `pre-execute` 为准。
 *
 * 这个语义写进 README 的"能力上限"，因为它决定了会话档在
 * 高并发场景下是"尽力而为"而非"严格隔离"。
 *
 * ## 存储
 *
 * `prompts/session/<safe-id>.md`。会话 id 是 UUID 形态，但仍要做文件名消毒，
 * 挡住路径穿越。
 *
 * @module dsh-auto-review-custom/session-prompts
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 会话档目录名（在 `prompts/` 下）。 */
export const SESSION_DIR = 'session'

/** 会话档文件名后缀。 */
export const SESSION_PROMPT_SUFFIX = '.md'

/** 绑定槽的默认有效期：15 秒。 */
export const DEFAULT_BINDING_TTL_MS = 15_000

/**
 * 把会话 id 变成安全的单段文件名。
 *
 * 只保留 `[\w.-]`，其余替换成 `_`；再去掉开头的点（避免 `.`/`..` 与隐藏文件
 * 语义），空值或只剩点号时返回 null（拒绝写）。
 *
 * @param {unknown} sessionId
 * @returns {string | null}
 */
export function safeSessionId(sessionId) {
  const raw = String(sessionId ?? '').trim()
  if (raw === '') return null
  // 顺序不能反：先把分隔符抹成 `_`，再压平点号——否则 `../../etc` 抹完还会
  // 留下 `..` 片段，虽然已无斜杠不构成穿越，但文件名会误导阅读者。
  const cleaned = raw
    .replace(/[^\w.-]+/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 120)
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return null
  return cleaned
}

/** 会话档文件绝对路径。 */
function sessionFile(root, key) {
  return join(root, 'prompts', SESSION_DIR, `${key}${SESSION_PROMPT_SUFFIX}`)
}

/**
 * 读一个提示词文件；不存在或只剩注释/空白时返回空串。
 *
 * 与会话/工作区档同一套 `.md` 规则（`#` 开头整行是注释）。
 *
 * @param {string} path
 * @returns {string}
 */
function readPromptFile(path) {
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
      .trim()
  } catch {
    return ''
  }
}

/**
 * 读某个会话的提示词。
 *
 * @param {string} root
 * @param {unknown} sessionId
 * @returns {string}
 */
export function readSessionPrompt(root, sessionId) {
  const key = safeSessionId(sessionId)
  if (key === null) return ''
  return readPromptFile(sessionFile(root, key))
}

/**
 * 写某个会话的提示词；空串等于删除该档。
 *
 * @param {string} root
 * @param {unknown} sessionId
 * @param {unknown} text
 * @returns {{ ok: boolean, sessionId: string, removed: boolean }}
 */
export function writeSessionPrompt(root, sessionId, text) {
  const key = safeSessionId(sessionId)
  if (key === null) throw new Error('会话 id 不合法')
  const body = String(text ?? '').trim()
  const path = sessionFile(root, key)
  if (body === '') {
    rmSync(path, { force: true })
    return { ok: true, sessionId: key, removed: true }
  }
  mkdirSync(join(root, 'prompts', SESSION_DIR), { recursive: true })
  writeFileSync(path, `${body}\n`, 'utf8')
  return { ok: true, sessionId: key, removed: false }
}

/**
 * 列出所有会话档。
 *
 * @param {string} root
 * @returns {Array<{ sessionId: string, prompt: string, bytes: number }>}
 */
export function listSessionPrompts(root) {
  const dir = join(root, 'prompts', SESSION_DIR)
  if (!existsSync(dir)) return []
  /** @type {Array<{ sessionId: string, prompt: string, bytes: number }>} */
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!entry.endsWith(SESSION_PROMPT_SUFFIX)) continue
    const full = join(dir, entry)
    try {
      if (!statSync(full).isFile()) continue
    } catch {
      continue
    }
    const prompt = readPromptFile(full)
    if (prompt === '') continue
    out.push({
      sessionId: entry.slice(0, -SESSION_PROMPT_SUFFIX.length),
      prompt,
      bytes: Buffer.byteLength(prompt, 'utf8'),
    })
  }
  return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
}

/**
 * 会话 id ↔ cwd 的**短时绑定槽**。
 *
 * 存在的原因见文件头：审查请求里没有 sessionId，只能从
 * `tools/pre-execute` 旁路把"这个 cwd 上刚被审的是哪个会话"记下来。
 *
 * 设计取舍：
 * - 按 cwd 分槽，不同工作区互不干扰；
 * - 带 TTL，过期即失效（宁可漏注入，也不串会话）；
 * - 只记最近一次，不排队（评审一个调用只对应一次审查请求）。
 */
export function createSessionBinding(ttlMs = DEFAULT_BINDING_TTL_MS) {
  /** @type {Map<string, { sessionId: string, at: number }>} */
  const slots = new Map()

  const keyOf = (cwd) => (typeof cwd === 'string' && cwd !== '' ? cwd.toLowerCase() : '')

  return {
    /**
     * 记下「这个 cwd 上正在被审的是这个会话」。
     *
     * @param {string | undefined} cwd
     * @param {unknown} sessionId
     */
    bind(cwd, sessionId) {
      const key = safeSessionId(sessionId)
      if (key === null) return
      slots.set(keyOf(cwd), { sessionId: key, at: Date.now() })
    },

    /**
     * 取该 cwd 上仍然有效的会话绑定。
     *
     * @param {string | undefined} cwd
     * @returns {string | null}
     */
    resolve(cwd) {
      const slot = slots.get(keyOf(cwd))
      if (slot === undefined) return null
      if (Date.now() - slot.at > ttlMs) {
        slots.delete(keyOf(cwd))
        return null
      }
      return slot.sessionId
    },

    /** 清空（测试用）。 */
    clear() {
      slots.clear()
    },
  }
}
