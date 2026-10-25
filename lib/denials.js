/**
 * Auto review **拒绝记录**（denials）—— 0.2.0 新增。
 *
 * ## 为什么单独一个文件
 *
 * 0.1.x 只记 `decisions.jsonl`，而且只记**我们自己放行**的那一条
 * （`lib/index.js` 的 `audit()` 只挂在静态放行分支上）。审查器判 deny / 问用户
 * 的结果从来没落过盘，所以"该给这个工作区补什么提示词"完全无从复盘。
 *
 * 0.2.0 起把 `tools/pre-execute` 里 `await next()` 拿到的**最终判决**也记下来。
 * 判决是宿主 `dsh-tools` 的 waterfall 返回值，形状见
 * `dsh-tools/lib/index.js:3241-3253`：
 *
 * ```js
 * const denialReason = decision.kind === 'allow' ? this.guardReason(exec) : decision.reason
 * const denialInfo = decision.kind === 'deny' ? decision.info : void 0
 * ```
 *
 * 所以 `kind` 有三种我们要记的值：
 *
 * | kind | 含义 | 有 reason |
 * |---|---|---|
 * | `deny` | 硬拒绝（含 `failed()` 的 fail-closed） | 是 |
 * | `ask`  | 判 deny 但弹给用户裁决 | 是 |
 * | `fail` | 审查请求本身跑挂（`AutoReviewDeniedError` 即属此类） | 是 |
 *
 * ## 为什么必须有 session / workspace 维度
 *
 * 复盘提示词的粒度是"这个工作区该补一句什么"，所以每条记录必须能回答
 * 「哪个会话、哪个工作区、什么工具、为什么被拒」。只有工具名 + 理由的记录
 * 是没法用来写提示词的。
 *
 * ## 与 `decisions.jsonl` 的关系
 *
 * 两个文件分工明确，互不替代：
 *
 * - `decisions.jsonl` —— 插件**自己的放行**（静态放行），有 `ruleId`。
 * - `denials.jsonl`  —— **审查器的结论**（被拒 / 被问），有 `reason`。
 *
 * @module dsh-auto-review-custom/denials
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 拒绝日志文件名。 */
export const DENIALS_FILE = 'denials.jsonl'

/** 单条记录里 `arg` 摘要的最大字符数。 */
const ARG_MAX = 400

/** 单条记录里 `reason` 的最大字符数（审查理由通常 200–600 字）。 */
const REASON_MAX = 1200

/** 要脱敏的键名。 */
const SECRET_KEY = /(password|passwd|pwd|token|secret|apikey|api_key|credential|authorization)/i

/**
 * 把工具参数压成一行**可复盘**的摘要。
 *
 * ## 为什么不能直接 `JSON.stringify(...).slice(0, 200)`
 *
 * 0.1.x 就是这么干的，实测 1086 条里有 653 条正好截在 200 字符，其中 197 条
 * 是 `write`/`edit`——`content` 排在前面把 `file_path` 挤掉了，记录退化成
 * 「某人写了 200 字符」，完全无法复盘。
 *
 * 所以这里**先抽关键字段，再截断**：`file_path` / `path` / `command` 一定保留。
 *
 * @param {unknown} args
 * @returns {string}
 */
export function summarizeArgs(args) {
  if (args === null || args === undefined) return ''
  if (typeof args !== 'object') return maskSecrets(String(args)).slice(0, ARG_MAX)

  const record = /** @type {Record<string, unknown>} */ (args)

  // 文件类：路径是唯一有用的信息，必须完整保留。
  const path = typeof record.file_path === 'string' ? record.file_path : typeof record.path === 'string' ? record.path : null
  if (path !== null) {
    const extra = typeof record.command === 'string' ? ` | cmd=${maskSecrets(record.command).slice(0, 160)}` : ''
    return `${path}${extra}`.slice(0, ARG_MAX)
  }

  // 命令类：命令本身就是要复盘的东西。
  if (typeof record.command === 'string') return maskSecrets(record.command).slice(0, ARG_MAX)

  try {
    return maskSecrets(JSON.stringify(record)).slice(0, ARG_MAX)
  } catch {
    return ''
  }
}

/**
 * 抹掉看起来像凭据的片段。
 *
 * 保守做法：既处理 `key=value` 形态，也处理 JSON 里 `"key":"value"` 形态。
 *
 * @param {string} text
 * @returns {string}
 */
export function maskSecrets(text) {
  return String(text)
    .replace(/("(?:[^"]{0,40})"\s*:\s*")(?:[^"\\]|\\.){1,400}(")/g, (whole, head, tail, offset, source) => {
      // 只有键名命中才替换，避免把普通 JSON 字段全抹掉。
      const key = /"([^"]{0,40})"\s*:/.exec(source.slice(Math.max(0, offset), offset + 80))
      if (key === null || !SECRET_KEY.test(key[1])) return whole
      return `${head}***${tail}`
    })
    .replace(/\b(password|passwd|pwd|token|secret|apikey|api_key|credential|authorization)(\s*[=:]\s*)\S+/gi, '$1$2***')
}

/**
 * 追加一条拒绝记录。
 *
 * 任何失败都静默吞掉：记录日志绝不能影响工具调用的判决。
 *
 * @param {string} dataRoot - `$DSH_HOME/auto-review`
 * @param {object} entry
 * @param {'deny'|'ask'|'fail'} entry.kind
 * @param {string} entry.tool
 * @param {unknown} [entry.args]
 * @param {string|null} [entry.reason]
 * @param {string|null} [entry.sessionId]
 * @param {string|null} [entry.cwd]
 * @param {string|null} [entry.workspace]
 * @param {string|null} [entry.callId]
 * @param {string|null} [entry.code] - `decision.info.code`（如 `AUTO_REVIEW_DENIED`）
 */
export function appendDenial(dataRoot, entry) {
  try {
    const reason = entry.reason === null || entry.reason === undefined
      ? null
      : String(entry.reason).slice(0, REASON_MAX)
    const record = {
      t: new Date().toISOString(),
      kind: entry.kind,
      tool: entry.tool,
      sessionId: entry.sessionId ?? null,
      cwd: entry.cwd ?? null,
      workspace: entry.workspace ?? null,
      callId: entry.callId ?? null,
      code: entry.code ?? null,
      reason,
      arg: summarizeArgs(entry.args),
    }
    mkdirSync(dataRoot, { recursive: true })
    appendFileSync(join(dataRoot, DENIALS_FILE), `${JSON.stringify(record)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 读全部拒绝记录（新→旧）。
 *
 * 坏行跳过：日志文件可能被写入方中途截断（例如进程被杀），
 * 一行坏 JSON 不该让整个查询失败。
 *
 * @param {string} dataRoot
 * @returns {Array<any>}
 */
export function readDenials(dataRoot) {
  const path = join(dataRoot, DENIALS_FILE)
  if (!existsSync(path)) return []
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  /** @type {Array<any>} */
  const out = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object') out.push(parsed)
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

/**
 * 按条件筛出拒绝记录，新的在前。
 *
 * 所有条件都是**可选**的与关系。`cwd` 与 `workspace` 走"彼此是祖先或相等"
 * 的匹配，与会话/工作区提示词的命中规则保持一致——否则查询结果会和
 * "这条提示词到底会不会生效"对不上。
 *
 * @param {string} dataRoot
 * @param {object} [filter]
 * @param {string} [filter.sessionId] - 精确匹配会话 id。
 * @param {string} [filter.cwd] - 精确匹配该工作目录，或其后代目录。
 * @param {string} [filter.workspace] - 精确匹配工作区目录名。
 * @param {string} [filter.tool] - 精确匹配工具名。
 * @param {string} [filter.kind] - `deny` / `ask` / `fail`。
 * @param {number} [filter.since] - 起始时间（毫秒时间戳，含）。
 * @param {number} [filter.limit] - 最多返回条数（默认 50）。
 * @param {string} [filter.contains] - 理由/参数里的关键字（大小写不敏感）。
 * @returns {{ items: Array<any>, total: number, files: string }}
 */
export function queryDenials(dataRoot, filter = {}) {
  const all = readDenials(dataRoot)
  const cwdWanted = typeof filter.cwd === 'string' && filter.cwd !== '' ? normalizePath(filter.cwd) : null
  const contains = typeof filter.contains === 'string' && filter.contains !== '' ? filter.contains.toLowerCase() : null
  const limit = Number.isFinite(filter.limit) && filter.limit > 0 ? Math.floor(filter.limit) : 50

  const matched = []
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const item = all[i]
    if (typeof filter.sessionId === 'string' && filter.sessionId !== '' && item.sessionId !== filter.sessionId) continue
    if (typeof filter.workspace === 'string' && filter.workspace !== '' && item.workspace !== filter.workspace) continue
    if (typeof filter.tool === 'string' && filter.tool !== '' && item.tool !== filter.tool) continue
    if (typeof filter.kind === 'string' && filter.kind !== '' && item.kind !== filter.kind) continue
    if (cwdWanted !== null) {
      const have = typeof item.cwd === 'string' && item.cwd !== '' ? normalizePath(item.cwd) : null
      if (have === null || !isUnder(have, cwdWanted)) continue
    }
    if (Number.isFinite(filter.since) && filter.since > 0) {
      const at = Date.parse(item.t)
      if (!Number.isFinite(at) || at < filter.since) continue
    }
    if (contains !== null) {
      const haystack = `${item.reason ?? ''}\n${item.arg ?? ''}\n${item.tool ?? ''}`.toLowerCase()
      if (!haystack.includes(contains)) continue
    }
    matched.push(item)
    if (matched.length >= limit) break
  }

  return {
    items: matched,
    total: all.length,
    files: join(dataRoot, DENIALS_FILE),
  }
}

/** 规范化路径用于比较（Windows 大小写不敏感）。 */
function normalizePath(path) {
  const value = String(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/** `child` 是否等于 `parent` 或在其之下（纯词法，输入已规范化）。 */
function isUnder(child, parent) {
  if (child === parent) return true
  return child.startsWith(`${parent}/`) || child.startsWith(`${parent}\\`)
}

/**
 * 把记录压成便于阅读/喂给模型的一行。
 *
 * @param {any} item
 * @returns {string}
 */
export function formatDenialLine(item) {
  const when = typeof item.t === 'string' ? item.t.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '?'
  const where = item.workspace === null || item.workspace === undefined ? '(未匹配工作区)' : item.workspace
  const reason = item.reason === null || item.reason === undefined ? '(无理由)' : String(item.reason).replace(/\s+/g, ' ')
  return `${when} [${item.kind}] ${item.tool} @ ${where} | ${reason}`
}
