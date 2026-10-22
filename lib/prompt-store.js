/**
 * 审查提示词的**文件存储**（Host 半区）。
 *
 * ## 为什么放回文件
 *
 * 提示词是**内容**，不是开关：一段几百字的中文塞进 `cordis.patch.yml` 会让那个
 * 文件既难手改、也没法进 git diff。所以：
 *
 * | 数据 | 存哪 | 为什么 |
 * |---|---|---|
 * | 三个开关 | Config（profile patch） | 短、结构化、设置页的标准去处 |
 * | 提示词 | `$DSH_HOME/auto-review/prompts/**` | 长文本，需要可直接编辑 |
 *
 * 浏览器不能写文件，所以这层由 Host 的 Remote 方法暴露（见 `typert.js`）。
 *
 * ## 目录布局
 *
 * ```
 * prompts/
 * ├── global.md                          ← 全局提示词
 * └── workspace/<名字>-<哈希>/
 *     ├── note.md                        ← 该工作区的提示词
 *     └── meta.json                       ← {"path": "<工作区绝对路径>"}
 * ```
 *
 * 目录名带 8 位哈希是为了避免两个工作区同名（`D:\a\proj` 与 `D:\b\proj`）。
 *
 * @module dsh-auto-review-custom/prompt-store
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

/** 全局档文件名。 */
export const GLOBAL_PROMPT_FILE = 'global.md'
/** 工作区档文件名。 */
export const WORKSPACE_PROMPT_FILE = 'note.md'
/** 工作区档元信息文件名。 */
export const WORKSPACE_META_FILE = 'meta.json'

/**
 * 把绝对路径变成一个稳定、可读、无冲突的目录名。
 *
 * @param {string} workspacePath
 * @returns {string}
 */
export function workspaceDirName(workspacePath) {
  const normalized = resolve(workspacePath)
  const hash = createHash('sha1').update(normalized.toLowerCase()).digest('hex').slice(0, 8)
  const leaf = basename(normalized).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'workspace'
  return `${leaf}-${hash}`
}

/** 读一个 .md；不存在或只有注释/空白时返回空串。 */
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
 * 读全局提示词。
 *
 * @param {string} root - 数据根目录（`$DSH_HOME/auto-review`）。
 * @returns {string}
 */
export function readGlobalPrompt(root) {
  return readPromptFile(join(root, 'prompts', GLOBAL_PROMPT_FILE))
}

/**
 * 写全局提示词；传空串等于删除。
 *
 * @param {string} root
 * @param {string} text
 */
export function writeGlobalPrompt(root, text) {
  const path = join(root, 'prompts', GLOBAL_PROMPT_FILE)
  const body = String(text ?? '').trim()
  mkdirSync(join(root, 'prompts'), { recursive: true })
  if (body === '') {
    rmSync(path, { force: true })
    return
  }
  writeFileSync(path, `${body}\n`, 'utf8')
}

/**
 * 列出所有工作区提示词档。
 *
 * @param {string} root
 * @returns {Array<{ name: string, path: string, prompt: string }>}
 */
export function listWorkspacePrompts(root) {
  const dir = join(root, 'prompts', 'workspace')
  if (!existsSync(dir)) return []

  /** @type {Array<{ name: string, path: string, prompt: string }>} */
  const out = []
  for (const entry of readdirSync(dir)) {
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
    out.push({
      name: entry,
      path: meta.path,
      prompt: readPromptFile(join(full, WORKSPACE_PROMPT_FILE)),
    })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * 按工作区路径找出**已存在的**目录名。
 *
 * 目录名的来源有两代：早期 CLI 用 `--name`（如 `autoreview-project`），
 * 现在按 `<basename>-<hash>` 生成。不先查重的话，同一条路径会被写成两个档。
 *
 * @param {string} root
 * @param {string} normalizedPath - 已 `resolve` 的绝对路径。
 * @returns {string | null}
 */
export function findWorkspaceDirName(root, normalizedPath) {
  const dir = join(root, 'prompts', 'workspace')
  if (!existsSync(dir)) return null
  const target = normalizedPath.toLowerCase()
  for (const entry of readdirSync(dir)) {
    const metaPath = join(dir, entry, WORKSPACE_META_FILE)
    if (!existsSync(metaPath)) continue
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      if (typeof meta?.path === 'string' && resolve(meta.path).toLowerCase() === target) return entry
    } catch {
      /* 坏档跳过 */
    }
  }
  return null
}

/**
 * 写（或新建）一个工作区提示词档。
 *
 * 已有同路径的档会就地更新，不会新建重复目录。
 *
 * @param {string} root
 * @param {string} workspacePath - 工作区绝对路径。
 * @param {string} text - 提示词；空串等于删除该档。
 * @returns {string} 目录名。
 */
export function writeWorkspacePrompt(root, workspacePath, text) {
  const normalized = resolve(String(workspacePath ?? '').trim())
  if (normalized.length === 0) throw new Error('工作区路径不能为空')
  const existing = findWorkspaceDirName(root, normalized)
  const name = existing ?? workspaceDirName(normalized)
  const dir = join(root, 'prompts', 'workspace', name)
  const body = String(text ?? '').trim()

  if (body === '') {
    rmSync(dir, { recursive: true, force: true })
    return name
  }

  mkdirSync(dir, { recursive: true })
  // 已有档的 meta 里存的是首次写入时的路径拼写，保留它——避免调用方传了
  // 不同大小写/斜杠就把用户原本的记录冲掉。
  const metaPath = join(dir, WORKSPACE_META_FILE)
  let recordedPath = normalized
  if (existsSync(metaPath)) {
    try {
      const previous = JSON.parse(readFileSync(metaPath, 'utf8'))
      if (typeof previous?.path === 'string' && previous.path.length > 0) recordedPath = previous.path
    } catch {
      /* 坏档就用新路径 */
    }
  }
  writeFileSync(metaPath, `${JSON.stringify({ path: recordedPath }, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, WORKSPACE_PROMPT_FILE), `${body}\n`, 'utf8')
  return name
}

/**
 * 按目录名删除一个工作区提示词档。
 *
 * @param {string} root
 * @param {string} name - 目录名（不是路径）。
 * @returns {boolean} 是否真的删掉了。
 */
export function removeWorkspacePrompt(root, name) {
  const safe = String(name ?? '').trim()
  // 只接受单段目录名，挡住目录穿越。
  if (safe === '' || safe === '.' || safe === '..' || /[\\/]/.test(safe)) return false
  const dir = join(root, 'prompts', 'workspace', safe)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/**
 * 读全部提示词状态（供 Remote 方法一次返回）。
 *
 * @param {string} root
 * @returns {{ global: string, workspaces: Array<{ name: string, path: string, prompt: string }> }}
 */
export function readAllPrompts(root) {
  return { global: readGlobalPrompt(root), workspaces: listWorkspacePrompts(root) }
}
