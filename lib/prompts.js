/**
 * 审查提示词的加载与合成：**全局 + 工作区 + 会话**三档。
 *
 * ## 三档作用域
 *
 * | 档 | 何时生效 | 存放文件 |
 * |---|---|---|
 * | 全局 global | 所有会话 | `prompts/global.md` |
 * | 工作区 workspace | 会话 cwd 匹配某个已注册工作区时 | `prompts/workspace/<目录名>/note.md` |
 * | 会话 session | 该会话发起的审查请求 | `prompts/session/<会话id>.md` |
 *
 * 合成顺序：**全局 → 工作区 → 会话**（越具体越靠后，压轴位置权重更高，
 * 与 REVIEW_POLICY 的 "more specific takes precedence" 一致）。
 *
 * > 会话档的 sessionId **不来自审查请求**（那里只有 `ENVIRONMENT.cwd`），
 * > 而是由 `lib/session-prompts.js` 的绑定槽从 `tools/pre-execute` 旁路带入。
 * > 拿不到绑定就不注入会话档——宁可漏，也不串会话。
 *
 * ## 工作区档怎么定位
 *
 * 审查请求里唯一可靠的身份是 `ENVIRONMENT.cwd`（会话工作目录）。
 * 因此每个工作区档目录下放一个 `meta.json` 记录该工作区的绝对路径，
 * 匹配规则是「`meta.path` 是 cwd 的祖先或相等」，多个命中时选**路径最长**的
 * （最具体的那个）。这样 `D:\Program Code` 与 `D:\Program Code\plugins`
 * 都注册时，后者的会话只命中后者。
 *
 * 用目录名而非 UUID 做键，是为了让 `manage.mjs` 能按可读名自动建目录，
 * 你不用记 UUID。
 *
 * ## 为什么文件是 .md
 *
 * 提示词是自然语言，会被反复手改。独立 .md 可以直接在编辑器里改、
 * 能进 git diff、不会被 YAML 缩进或引号规则破坏。
 *
 * @module dsh-auto-review-custom/prompts
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { readSessionPrompt } from './session-prompts.js'

/** 全局档文件名。 */
export const GLOBAL_PROMPT_FILE = 'global.md'

/** 工作区档文件名。 */
export const WORKSPACE_PROMPT_FILE = 'note.md'

/** 工作区档元信息文件名（记录该工作区的绝对路径）。 */
export const WORKSPACE_META_FILE = 'meta.json'

/**
 * 读一个提示词文件；不存在或只有空白/注释（`#` 开头整行）时返回 null。
 *
 * @param {string} path - 绝对路径。
 * @returns {string | null}
 */
export function readPrompt(path) {
  if (!existsSync(path)) return null
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const body = raw
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
    .trim()
  return body.length === 0 ? null : body
}

/**
 * 纯词法路径包含性判定（大小写按平台）。
 *
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isUnderLexically(child, parent) {
  const caseSensitive = process.platform !== 'win32'
  const a = caseSensitive ? child : child.toLowerCase()
  const b = caseSensitive ? parent : parent.toLowerCase()
  if (a === b) return true
  const prefix = b.endsWith(sep) ? b : b + sep
  return a.startsWith(prefix)
}

/**
 * 在 `prompts/workspace/` 下找出与 cwd 匹配的工作区档（多命中取最具体）。
 *
 * @param {string} root - 数据根目录。
 * @param {string} cwd - 会话工作目录。
 * @returns {{ text: string, id: string, path: string } | null}
 */
export function findWorkspacePrompt(root, cwd) {
  const found = matchWorkspace(root, cwd)
  if (found === null || found.text === null) return null
  return { text: found.text, id: found.id, path: found.path }
}

/**
 * 找出与 cwd 匹配的工作区档**目录名**，不要求该档有 `note.md`。
 *
 * 拒绝记录需要的是「这条调用属于哪个工作区」，即使那个工作区还没配提示词
 * 也要能回答——否则第一次复盘时所有记录都会显示"未匹配工作区"。
 *
 * @param {string} root
 * @param {string | undefined} cwd
 * @returns {{ id: string, path: string } | null}
 */
export function findWorkspaceId(root, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null
  const found = matchWorkspace(root, cwd)
  return found === null ? null : { id: found.id, path: found.path }
}

/**
 * 匹配工作区档的公共实现。
 *
 * @param {string} root
 * @param {string} cwd
 * @returns {{ text: string | null, id: string, path: string } | null}
 */
function matchWorkspace(root, cwd) {
  const dir = join(root, 'prompts', 'workspace')
  if (!existsSync(dir)) return null

  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }

  const target = resolve(cwd)
  /** @type {{ text: string | null, id: string, path: string, length: number } | null} */
  let best = null

  for (const entry of entries) {
    const full = join(dir, entry)
    try {
      if (!statSync(full).isDirectory()) continue
    } catch {
      continue
    }

    const metaPath = join(full, WORKSPACE_META_FILE)
    if (!existsSync(metaPath)) continue

    let meta
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    } catch {
      continue
    }
    if (meta === null || typeof meta !== 'object' || typeof meta.path !== 'string') continue

    const wsPath = resolve(meta.path)
    if (!isUnderLexically(target, wsPath)) continue

    if (best === null || wsPath.length > best.length) {
      best = { text: readPrompt(join(full, WORKSPACE_PROMPT_FILE)), id: entry, path: wsPath, length: wsPath.length }
    }
  }

  return best === null ? null : { text: best.text, id: best.id, path: best.path }
}

/**
 * 合成审查提示词。
 *
 * @param {object} input
 * @param {string} input.root - 数据根目录（`$DSH_HOME/auto-review`）。
 * @param {string | undefined} input.cwd - 会话工作目录。
 * @param {string | null} [input.sessionId] - 会话 id；取自绑定槽，拿不到时传 null。
 * @returns {{ text: string, parts: Array<{ scope: string, id: string, bytes: number }> }}
 */
export function composePrompts({ root, cwd, sessionId = null }) {
  /** @type {Array<{ scope: string, id: string, text: string }>} */
  const layers = []

  const globalText = readPrompt(join(root, 'prompts', GLOBAL_PROMPT_FILE))
  if (globalText !== null) layers.push({ scope: 'global', id: 'global', text: globalText })

  if (typeof cwd === 'string' && cwd.length > 0) {
    const ws = findWorkspacePrompt(root, cwd)
    if (ws !== null) layers.push({ scope: 'workspace', id: ws.id, text: ws.text })
  }

  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const sessionText = readSessionPrompt(root, sessionId)
    if (sessionText !== '') layers.push({ scope: 'session', id: sessionId, text: sessionText })
  }

  if (layers.length === 0) return { text: '', parts: [] }

  const text = layers
    .map((layer) => `[${layer.scope}:${layer.id}]\n${layer.text.trim()}`)
    .join('\n\n')

  return {
    text,
    parts: layers.map((layer) => ({
      scope: layer.scope,
      id: layer.id,
      bytes: Buffer.byteLength(layer.text, 'utf8'),
    })),
  }
}

/**
 * 从审查请求的 user 文本里取出 `ENVIRONMENT` 段的 cwd。
 *
 * ⚠️ `ENVIRONMENT` 是文本的**第一个**段，前面没有 `\n\n` 分隔符
 * （审查器用 `["ENVIRONMENT", json, "PROJECT_INSTRUCTIONS", ...].join("\n\n")` 拼接），
 * 因此锚点要单独处理"位于开头"和"位于中间"两种情况。
 *
 * @param {string} text - 审查请求的 user 消息全文。
 * @returns {string | undefined}
 */
export function cwdOfReviewText(text) {
  if (typeof text !== 'string') return undefined

  const HEAD = 'ENVIRONMENT\n\n'
  const MID = '\n\nENVIRONMENT\n\n'
  let start = -1
  if (text.startsWith(HEAD)) start = HEAD.length
  else {
    const at = text.indexOf(MID)
    if (at >= 0) start = at + MID.length
  }
  if (start < 0) return undefined

  const rest = text.slice(start)
  const end = rest.indexOf('\n\nPROJECT_INSTRUCTIONS')
  const raw = end < 0 ? rest : rest.slice(0, end)
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed?.cwd === 'string' ? parsed.cwd : undefined
  } catch {
    return undefined
  }
}
