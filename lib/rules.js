/**
 * 判定一个工具调用是「静态放行」还是「交给 auto review」。
 *
 * ## 设计原则（按用户确认的最终形态）
 *
 * ```
 * 工具调用
 * ├─ 文件类工具且目标在 cwd 内  → 静态放行（与 DSH 沙箱语义一致）
 * └─ 其它                      → 交给 auto review 的 AI 判断
 * ```
 *
 * **没有正则白名单，也没有静态底线。**
 * 命令类工具（`pwsh` 等）一律交给 AI，由审查提示词表达偏好——
 * 这是刻意设计：命令的副作用无法静态判定，文本匹配式的"底线"
 * 只是黑名单，永远补不完（2026-10-17 实测 `Remove-Item -Recurse -Force C:\Windows`
 * 就漏过），而且它只能做到"不免审"，挡不住用户手动批准，等于空转。
 *
 * ## 为什么文件类工具可以静态放行
 *
 * 因为 DSH 沙箱**已经**在用它自己的语义判定"这个路径能不能写"：
 * 目标必须在 `writableRoots` 之下。我们只是把这个**已经确定的结论**
 * 提前用于"要不要审查"，两者不可能冲突：
 *
 * - 沙箱判「可写」→ 我们放行 → 调用真的成功（沙箱本来也会允许）
 * - 沙箱判「不可写」→ 我们不放行 → 交给 AI 复审，不改变沙箱的最终裁决
 *
 * 判定逻辑复刻 `@deepseek-ai/dsh-fs-sandbox` 的 `isPathUnder`：
 * 先小写词法比较（Windows 大小写不敏感），不匹配再按 dev+ino 文件身份逐层上溯。
 * 这样软链、8.3 短名、大小写差异都不会误判。
 *
 * @module dsh-auto-review-custom/rules
 */

import { stat } from 'node:fs/promises'
import { dirname, resolve as resolvePath, sep } from 'node:path'
import { tmpdir } from 'node:os'

/** 文件类工具：它们的目标路径可以静态判定。 */
const FILE_TOOLS = new Set(['read', 'write', 'edit'])

/** 缺失类错误码（与沙箱实现一致）。 */
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR'])

/** Windows 大小写不敏感；其余平台敏感（与沙箱默认一致）。 */
const CASE_SENSITIVE = process.platform !== 'win32'

/**
 * 取工具调用的目标路径。
 *
 * @param {string} toolName
 * @param {unknown} args
 * @returns {string | null}
 */
export function filePathOf(toolName, args) {
  if (!FILE_TOOLS.has(toolName)) return null
  if (args === null || typeof args !== 'object') return null
  const record = /** @type {Record<string, unknown>} */ (args)
  return typeof record.file_path === 'string' ? record.file_path : null
}

// ── 沙箱等价路径判定（复刻 dsh-fs-sandbox 的 isPathUnder） ───────────────

/** 按平台大小写规则生成可比较的路径。 */
function comparablePath(path, caseSensitive) {
  return caseSensitive ? path : path.toLowerCase()
}

/** 纯词法判定：path 是否等于 root 或在其之下。 */
function isLexicallyUnder(path, root, caseSensitive) {
  const target = comparablePath(path, caseSensitive)
  const base = comparablePath(root, caseSensitive)
  if (target === base) return true
  const prefix = base.endsWith(sep) ? base : base + sep
  return target.startsWith(prefix)
}

/** stat 一个路径；不存在返回 undefined（其它错误上抛，与沙箱一致）。 */
async function statIfPresent(path) {
  try {
    return await stat(path, { bigint: true })
  } catch (error) {
    if (MISSING_CODES.has(/** @type {any} */ (error)?.code)) return undefined
    throw error
  }
}

/** 两个 stat 结果是否指向同一文件系统对象。 */
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * 判断 `path` 是否等于 `root` 或位于其下。
 *
 * 词法快速路径覆盖正常写法；写法不一致时（软链、8.3 短名、大小写）
 * 沿 `path` 的祖先前上逐层比较**文件身份**，不把包含性退化成文本近似。
 *
 * @param {string} path - 规范化后的目标路径。
 * @param {string} root - 规范化后的可写根。
 * @returns {Promise<boolean>}
 */
export async function isPathUnder(path, root) {
  if (isLexicallyUnder(path, root, CASE_SENSITIVE)) return true
  const rootInfo = await statIfPresent(root)
  if (rootInfo === undefined) return false
  let ancestor = path
  for (;;) {
    const ancestorInfo = await statIfPresent(ancestor)
    if (ancestorInfo !== undefined && sameIdentity(ancestorInfo, rootInfo)) return true
    const parent = dirname(ancestor)
    if (parent === ancestor) return false
    ancestor = parent
  }
}

/**
 * 当前会话的"可静态放行根"：与沙箱的 `writableRoots` 完全一致。
 *
 * 沙箱实现（`dsh-sandbox` 的 `writableRoots`）在 workspace-write 下返回：
 * `[workspaceRoot, "/tmp", tmpdir()]`（各自规范化）。
 *
 * @param {string | undefined} cwd - 会话工作目录。
 * @returns {string[]}
 */
export function writableRootsFor(cwd) {
  const roots = []
  if (typeof cwd === 'string' && cwd.length > 0) roots.push(resolvePath(cwd))
  roots.push('/tmp', tmpdir())
  return [...new Set(roots.map((r) => resolvePath(r)))]
}

/**
 * 判定一个工具调用。
 *
 * @param {object} input
 * @param {string} input.toolName
 * @param {unknown} input.args - 工具参数（已解析）。
 * @param {string | undefined} input.cwd - 会话工作目录（`session.header.cwd`）。
 * @returns {Promise<{ action: 'allow' | 'review', reason?: string }>}
 */
export async function decide({ toolName, args, cwd }) {
  // 只有文件类工具可能被静态放行。
  if (!FILE_TOOLS.has(toolName)) return { action: 'review' }

  const filePath = filePathOf(toolName, args)
  if (filePath === null) return { action: 'review' }

  // 目标必须在沙箱可写根之内（与沙箱语义一致）。
  const target = resolvePath(cwd ?? process.cwd(), filePath)
  for (const root of writableRootsFor(cwd)) {
    try {
      if (await isPathUnder(target, root)) {
        return { action: 'allow', reason: `目标在可写根内（${root}）` }
      }
    } catch {
      // 判定出错时保守：不放行，交给 AI。
    }
  }

  return { action: 'review', reason: '目标在可写根之外' }
}
