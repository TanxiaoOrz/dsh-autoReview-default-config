/**
 * 维护工具：查看/写入两档提示词（全局 + 工作区）、配置，以及自检。
 *
 * 所有写入都是**原子写 + 先备份**；所有读取都与插件共用同一套解析/合成逻辑
 * （直接 import 插件的 lib/*.js），保证"工具看到的"与"插件实际生效的"一致。
 *
 * 用法见 README。数据目录由 `--home` 指定，缺省读环境变量 DSH_HOME。
 *
 * @module dsh-auto-review-custom/manage
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { DEFAULT_CONFIG, parseConfig } from './config.js'
import { isReviewRequest, PROJECT_INSTRUCTIONS_ANCHOR, REVIEW_SYSTEM_FINGERPRINT, SUPPORTED_HOST_VERSION } from './compat.js'
import { formatDenialLine, queryDenials, readDenials } from './denials.js'
import {
  composePrompts,
  GLOBAL_PROMPT_FILE,
  readPrompt,
  WORKSPACE_META_FILE,
  WORKSPACE_PROMPT_FILE,
} from './prompts.js'
import { listSessionPrompts, readSessionPrompt, safeSessionId, writeSessionPrompt } from './session-prompts.js'

/** 数据目录名（与插件保持一致）。 */
const DATA_DIR = 'auto-review'

/** 解析命令行参数：`--key value` 与 `--flag`。 */
export function parseArgs(argv) {
  /** @type {Record<string, string | true>} */
  const out = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else {
        out[key] = next
        i += 1
      }
    } else positional.push(token)
  }
  return { flags: out, positional }
}

/**
 * 定位数据根目录。
 *
 * @param {Record<string, string | true>} flags
 * @returns {string}
 */
export function dataRootOf(flags) {
  if (typeof flags.home === 'string') return resolve(flags.home, DATA_DIR)
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) return join(home, DATA_DIR)
  throw new Error('找不到 DSH_HOME；请设置环境变量或用 --home 指定')
}

/** 原子写：先写临时文件再 rename，并保留 `<name>.bak-<ts>`。 */
function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(path, `${path}.bak-${stamp}`)
  }
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

/** 工作区档根目录：`<root>/prompts/workspace`。 */
function workspaceDirOf(root) {
  return join(root, 'prompts', 'workspace')
}

/**
 * 校验工作区档名：它会被当作目录名使用，必须挡住路径穿越。
 *
 * @param {unknown} name
 * @returns {string}
 */
function assertWorkspaceName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('需要 --name <目录名>（对应 prompts/workspace/<目录名>/）')
  }
  const value = name.trim()
  if (/[\\/\0]/.test(value) || value === '.' || value === '..') {
    throw new Error(`--name 不能包含路径分隔符或写成 . / ..：${value}`)
  }
  return value
}

/**
 * 读一个工作区档的元信息；不是合法目录或 meta.json 不可用时返回 null。
 *
 * @param {string} root
 * @param {string} name - 目录名。
 * @returns {{ name: string, path: string, dir: string, hasPrompt: boolean, bytes: number, error?: string } | null}
 */
function readWorkspaceEntry(root, name) {
  const dir = join(workspaceDirOf(root), name)
  try {
    if (!statSync(dir).isDirectory()) return null
  } catch {
    return null
  }

  const metaPath = join(dir, WORKSPACE_META_FILE)
  if (!existsSync(metaPath)) return { name, path: '', dir, hasPrompt: false, bytes: 0, error: `${WORKSPACE_META_FILE} 缺失` }

  let meta
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch (error) {
    return { name, path: '', dir, hasPrompt: false, bytes: 0, error: `${WORKSPACE_META_FILE} 非法：${String(error?.message ?? error)}` }
  }
  if (meta === null || typeof meta !== 'object' || typeof meta.path !== 'string' || meta.path.trim() === '') {
    return { name, path: '', dir, hasPrompt: false, bytes: 0, error: `${WORKSPACE_META_FILE} 缺少 path` }
  }

  const text = readPrompt(join(dir, WORKSPACE_PROMPT_FILE))
  return {
    name,
    path: meta.path,
    dir,
    hasPrompt: text !== null,
    bytes: text === null ? 0 : Buffer.byteLength(text, 'utf8'),
  }
}

/**
 * 列出全部工作区档。
 *
 * @param {string} root
 * @returns {Array<NonNullable<ReturnType<typeof readWorkspaceEntry>>>}
 */
function listWorkspaces(root) {
  const dir = workspaceDirOf(root)
  if (!existsSync(dir)) return []
  let entries
  try {
    entries = readdirSync(dir).sort()
  } catch {
    return []
  }
  const out = []
  for (const name of entries) {
    const entry = readWorkspaceEntry(root, name)
    if (entry !== null) out.push(entry)
  }
  return out
}

// ── 子命令 ────────────────────────────────────────────────────────────────

/** `doctor`：自检数据目录、配置合法性、两档提示词（含工作区档）可达性。 */
function cmdDoctor(root) {
  const lines = []
  const ok = (m) => lines.push(`  [OK]   ${m}`)
  const bad = (m) => lines.push(`  [FAIL] ${m}`)
  const info = (m) => lines.push(`  [INFO] ${m}`)

  lines.push(`数据目录：${root}`)
  lines.push(`适配宿主版本：${SUPPORTED_HOST_VERSION}`)
  lines.push(`审查指纹：${JSON.stringify(REVIEW_SYSTEM_FINGERPRINT.slice(0, 24) + '…')}`)
  lines.push('')

  if (!existsSync(root)) {
    info('数据目录尚不存在（插件会用默认配置运行）')
  }

  // config.json
  const configPath = join(root, 'config.json')
  let config = DEFAULT_CONFIG
  try {
    config = existsSync(configPath) ? parseConfig(readFileSync(configPath, 'utf8')) : DEFAULT_CONFIG
    ok(`config.json 合法：${JSON.stringify(config)}`)
  } catch (error) {
    bad(`config.json 非法：${String(error?.message ?? error)}`)
  }

  if (config.allowRules) {
    info('静态放行开启：仅对文件类工具（read/write/edit）生效，且目标须在沙箱可写根内')
    info('  命令类工具（pwsh 等）永远交给 auto review，不受此开关影响')
  } else {
    info('静态放行关闭：所有工具调用都交给 auto review')
  }

  // 全局提示词
  const globalPrompt = readPrompt(join(root, 'prompts', GLOBAL_PROMPT_FILE))
  if (globalPrompt === null) info(`未配置全局提示词（${GLOBAL_PROMPT_FILE} 不存在或为空）`)
  else ok(`全局提示词：${Buffer.byteLength(globalPrompt, 'utf8')} 字节`)

  // 工作区档
  const workspaces = listWorkspaces(root)
  if (workspaces.length === 0) {
    info(`未配置工作区档（${workspaceDirOf(root)}）`)
  } else {
    ok(`工作区档：${workspaces.length} 个`)
    for (const ws of workspaces) {
      if (ws.error !== undefined) {
        bad(`  工作区 ${ws.name}：${ws.error}`)
        continue
      }
      if (!ws.hasPrompt) {
        bad(`  工作区 ${ws.name}：${WORKSPACE_PROMPT_FILE} 缺失或为空（path=${ws.path}）`)
        continue
      }
      ok(`  工作区 ${ws.name}：path=${ws.path}，${ws.bytes} 字节`)
    }
  }

  lines.push('')
  if (config.prompts && globalPrompt === null && workspaces.length === 0) {
    const sessions = listSessionPrompts(root)
    if (sessions.length === 0) {
      info('提示：config.prompts=true 但没有配置任何提示词，审查时不会注入任何内容')
    }
  }

  // 会话档 + 拒绝记录（0.2.0）
  const sessions = listSessionPrompts(root)
  if (sessions.length === 0) {
    info(`未配置会话档（${join(root, 'prompts', 'session')}）`)
  } else {
    ok(`会话档：${sessions.length} 个`)
    for (const entry of sessions) ok(`  会话 ${entry.sessionId}：${entry.bytes} 字节`)
  }

  const denials = readDenials(root)
  if (denials.length === 0) {
    info('拒绝记录为空（denials.jsonl 不存在或还没有被拒的调用）')
  } else {
    const byKind = new Map()
    for (const item of denials) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1)
    ok(`拒绝记录：${denials.length} 条（${[...byKind.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}）`)
    info('  用 `denials --summary` 看按工作区/会话的分布')
  }

  lines.push('')
  lines.push('结论：' + (lines.some((l) => l.includes('[FAIL]')) ? '存在失败项，请修正后再用' : '未发现致命问题'))
  return lines.join('\n')
}

/** `list`：列出配置、提示词（全局 + 工作区）。 */
function cmdList(root) {
  const config = existsSync(join(root, 'config.json'))
    ? parseConfig(readFileSync(join(root, 'config.json'), 'utf8'))
    : { ...DEFAULT_CONFIG }

  const lines = []
  lines.push(`# 配置 (${join(root, 'config.json')})`)
  lines.push(JSON.stringify(config, null, 2))
  lines.push('')
  lines.push(`# 提示词 (${join(root, 'prompts')})`)

  const globalText = readPrompt(join(root, 'prompts', GLOBAL_PROMPT_FILE))
  lines.push(
    globalText === null
      ? `  global: (空)`
      : `  global: ${Buffer.byteLength(globalText, 'utf8')} 字节`,
  )

  const workspaces = listWorkspaces(root)
  if (workspaces.length === 0) {
    lines.push('  workspace: (无)')
  } else {
    lines.push(`  workspace: ${workspaces.length} 个`)
    for (const ws of workspaces) {
      if (ws.error !== undefined) {
        lines.push(`    - ${ws.name}  [异常] ${ws.error}`)
      } else {
        lines.push(`    - ${ws.name}  path=${ws.path}  ${ws.hasPrompt ? `${ws.bytes} 字节` : `[${WORKSPACE_PROMPT_FILE} 缺失]`}`)
      }
    }
  }

  lines.push('')
  lines.push('# 会话档 (0.2.0)')
  const sessions = listSessionPrompts(root)
  if (sessions.length === 0) lines.push('  session: (无)')
  else {
    lines.push(`  session: ${sessions.length} 个`)
    for (const entry of sessions) lines.push(`    - ${entry.sessionId}  ${entry.bytes} 字节`)
  }

  lines.push('')
  lines.push('# 拒绝记录 (0.2.0)')
  const denials = readDenials(root)
  lines.push(denials.length === 0 ? '  denials: (无)' : `  denials: ${denials.length} 条 —— 用 \`denials --summary\` 看分布`)

  lines.push('')
  lines.push('# 合成结果预览（global → workspace → session）')
  const composed = composePrompts({ root, cwd: undefined })
  lines.push(`  无工作区 cwd 时：${composed.parts.length} 段，${Buffer.byteLength(composed.text, 'utf8')} 字节`)

  return lines.join('\n')
}

/** `set-global`：写入全局提示词。 */
function cmdSetGlobal(root, flags) {
  if (typeof flags.text !== 'string' || flags.text.trim() === '') {
    throw new Error('set-global 需要 --text "提示词内容"')
  }
  const path = join(root, 'prompts', GLOBAL_PROMPT_FILE)
  writeAtomic(path, `${flags.text.trim()}\n`)
  return `已写入 ${path}`
}

/** `set-workspace`：写入工作区档（`note.md` + `meta.json`）。 */
function cmdSetWorkspace(root, flags) {
  const name = assertWorkspaceName(flags.name)
  if (typeof flags.path !== 'string' || flags.path.trim() === '') {
    throw new Error('set-workspace 需要 --path "工作区绝对路径"')
  }
  const absolutePath = resolve(flags.path.trim())
  if (typeof flags.text !== 'string' || flags.text.trim() === '') {
    throw new Error('set-workspace 需要 --text "提示词内容"')
  }

  const dir = join(workspaceDirOf(root), name)
  mkdirSync(dir, { recursive: true })
  writeAtomic(join(dir, WORKSPACE_PROMPT_FILE), `${flags.text.trim()}\n`)
  writeAtomic(join(dir, WORKSPACE_META_FILE), `${JSON.stringify({ path: absolutePath }, null, 2)}\n`)

  return [
    `已写入工作区档 ${name}（${dir}）`,
    `  ${WORKSPACE_META_FILE}: {"path":${JSON.stringify(absolutePath)}}`,
    `  ${WORKSPACE_PROMPT_FILE}: ${Buffer.byteLength(flags.text.trim(), 'utf8')} 字节`,
    '匹配规则：审查请求的 ENVIRONMENT.cwd 等于该路径或在其之下时生效；多个命中取路径最长者。',
  ].join('\n')
}

/** `rm-workspace`：删除工作区档目录。 */
function cmdRmWorkspace(root, flags) {
  const name = assertWorkspaceName(flags.name)
  const dir = join(workspaceDirOf(root), name)
  if (!existsSync(dir)) throw new Error(`找不到工作区档：${name}（${dir}）`)
  if (!statSync(dir).isDirectory()) throw new Error(`不是一个目录：${dir}`)
  rmSync(dir, { recursive: true, force: true })
  return `已删除工作区档 ${name}（${dir}）`
}

/** `set-config`：改开关。 */
function cmdSetConfig(root, flags) {
  const path = join(root, 'config.json')
  const current = existsSync(path) ? parseConfig(readFileSync(path, 'utf8')) : { ...DEFAULT_CONFIG }
  const next = { ...current }
  if (typeof flags.defaultPreset === 'string') {
    if (flags.defaultPreset !== 'auto' && flags.defaultPreset !== 'off') throw new Error('defaultPreset 只能是 auto 或 off')
    next.defaultPreset = flags.defaultPreset
  }
  if (flags.prompts !== undefined) next.prompts = flags.prompts !== 'off' && flags.prompts !== 'false'
  if (flags.allowRules !== undefined) next.allowRules = flags.allowRules !== 'off' && flags.allowRules !== 'false'
  writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`)
  return [
    `已写入 ${path}`,
    JSON.stringify(next, null, 2),
    '',
    '⚠️ 注意：这三个开关现在由**设置页**接管（存进 profile 的 cordis.patch.yml）。',
    '   插件的 Config schema 给每个字段都声明了默认值，所以 config.json 里的值',
    '   会被默认值遮住、不再生效。请到「设置 → Auto Review」里改，或直接编辑',
    '   profiles/<profile>/cordis.patch.yml 里 auto-review-custom 条目的 config。',
  ].join('\n')
}

/** `check-compat`：用一段样例请求验证"审查请求识别"仍然成立。 */
function cmdCheckCompat() {
  const sample = {
    provider: 'p',
    model: 'm',
    system: REVIEW_SYSTEM_FINGERPRINT + '\n...rest of policy...',
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              'ENVIRONMENT',
              '{"cwd":"C:\\\\x"}',
              PROJECT_INSTRUCTIONS_ANCHOR,
              '[]',
              'FILTERED_HISTORY',
              '[]',
              'PENDING_ACTION',
              '{"name":"pwsh","arguments":{"command":"git status"}}',
            ].join('\n\n'),
          },
        ],
      },
    ],
  }
  const detected = isReviewRequest(sample)
  const negative = isReviewRequest({ provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  const lines = [
    `审查请求识别（正例）：${detected ? 'PASS' : 'FAIL'}`,
    `主对话请求识别（应判否）：${negative ? 'FAIL 被误认' : 'PASS'}`,
  ]
  return lines.join('\n')
}

/** `denials`：查询审查拒绝记录（工作区 / 会话 / 工具 / 关键字）。 */
function cmdDenials(root, flags) {
  /** @type {Record<string, unknown>} */
  const filter = {}
  if (typeof flags.session === 'string') filter.sessionId = flags.session
  if (typeof flags.cwd === 'string') filter.cwd = flags.cwd
  if (typeof flags.workspace === 'string') filter.workspace = flags.workspace
  if (typeof flags.tool === 'string') filter.tool = flags.tool
  if (typeof flags.kind === 'string') filter.kind = flags.kind
  if (typeof flags.contains === 'string') filter.contains = flags.contains
  if (typeof flags.limit === 'string') filter.limit = Number.parseInt(flags.limit, 10)
  if (typeof flags.since === 'string') {
    const parsed = Date.parse(flags.since)
    if (!Number.isFinite(parsed)) throw new Error(`--since 不是合法时间：${flags.since}（例：2026-10-20 或 2026-10-20T08:00:00Z）`)
    filter.since = parsed
  }

  // `--summary`：只出统计（哪个工作区/会话被拒最多），适合决定先补哪条提示词。
  const result = queryDenials(root, { ...filter, limit: flags.summary !== undefined ? Number.MAX_SAFE_INTEGER : filter.limit })

  if (flags.summary !== undefined) {
    return formatDenialSummary(result.items, result.total, result.files)
  }

  const lines = [
    `拒绝记录：${result.files}`,
    `匹配 ${result.items.length} 条（文件共 ${result.total} 条；新的在前）`,
    '',
  ]
  if (result.items.length === 0) {
    lines.push('  （没有匹配记录）')
    if (result.total === 0) {
      lines.push('')
      lines.push('提示：denials.jsonl 是 0.2.0 起才开始写的。0.1.x 时期被拒绝的调用没有记录。')
    }
    return lines.join('\n')
  }
  for (const item of result.items) lines.push(`  ${formatDenialLine(item)}`)
  return lines.join('\n')
}

/**
 * 拒绝记录的**统计视图**。
 *
 * 复盘提示词时真正要回答的是「先给哪个工作区/工具补一句约束」，
 * 逐条列表反而看不出重点。
 *
 * @param {Array<any>} items
 * @param {number} total
 * @param {string} files
 */
function formatDenialSummary(items, total, files) {
  const byWorkspace = new Map()
  const bySession = new Map()
  const byTool = new Map()
  const byKind = new Map()

  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)

  for (const item of items) {
    bump(byWorkspace, item.workspace === null || item.workspace === undefined ? '(未匹配工作区)' : String(item.workspace))
    bump(bySession, item.sessionId === null || item.sessionId === undefined ? '(无会话)' : String(item.sessionId))
    bump(byTool, String(item.tool ?? '?'))
    bump(byKind, String(item.kind ?? '?'))
  }

  const render = (title, map) => {
    const rows = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    return [`# ${title}`, ...rows.map(([key, count]) => `  ${String(count).padStart(5)}  ${key}`)]
  }

  return [
    `拒绝记录：${files}`,
    `匹配 ${items.length} 条（文件共 ${total} 条）`,
    '',
    ...render('按工作区', byWorkspace),
    '',
    ...render('按会话', bySession),
    '',
    ...render('按工具', byTool),
    '',
    ...render('按结论', byKind),
    '',
    '下一步：给被拒最多的那个工作区补一条提示词——',
    '  node bin/manage.mjs set-workspace --path "<工作区绝对路径>" --name <目录名> --text "..."',
  ].join('\n')
}

/** `set-session`：写会话级提示词。 */
function cmdSetSession(root, flags) {
  if (typeof flags.session !== 'string' || flags.session.trim() === '') {
    throw new Error('set-session 需要 --session <会话 id>')
  }
  const key = safeSessionId(flags.session)
  if (key === null) throw new Error(`会话 id 不合法：${flags.session}`)
  if (typeof flags.text !== 'string') throw new Error('set-session 需要 --text "提示词内容"；传空串等于删除')

  const result = writeSessionPrompt(root, key, flags.text)
  if (result.removed) return `已删除会话档 ${key}（prompts/session/${key}.md）`
  return [
    `已写入会话档 ${key}（prompts/session/${key}.md）`,
    `  ${Buffer.byteLength(flags.text.trim(), 'utf8')} 字节`,
    '生效范围：仅该会话发起的审查请求；合成顺序 全局 → 工作区 → 会话。',
  ].join('\n')
}

/** `rm-session`：删除会话级提示词。 */
function cmdRmSession(root, flags) {
  if (typeof flags.session !== 'string' || flags.session.trim() === '') {
    throw new Error('rm-session 需要 --session <会话 id>')
  }
  const key = safeSessionId(flags.session)
  if (key === null) throw new Error(`会话 id 不合法：${flags.session}`)
  writeSessionPrompt(root, key, '')
  return `已删除会话档 ${key}`
}

/** `list-sessions`：列出所有会话档。 */
function cmdListSessions(root) {
  const entries = listSessionPrompts(root)
  if (entries.length === 0) return `没有会话档（${join(root, 'prompts', 'session')}）`
  const lines = [`会话档 ${entries.length} 个（${join(root, 'prompts', 'session')}）`]
  for (const entry of entries) {
    lines.push(`  ${entry.sessionId}  ${entry.bytes} 字节`)
  }
  return lines.join('\n')
}

/** 命令分发表。 */
const COMMANDS = {
  doctor: (root) => cmdDoctor(root),
  list: (root) => cmdList(root),
  'set-global': (root, flags) => cmdSetGlobal(root, flags),
  'set-workspace': (root, flags) => cmdSetWorkspace(root, flags),
  'rm-workspace': (root, flags) => cmdRmWorkspace(root, flags),
  'set-session': (root, flags) => cmdSetSession(root, flags),
  'rm-session': (root, flags) => cmdRmSession(root, flags),
  'list-sessions': (root) => cmdListSessions(root),
  denials: (root, flags) => cmdDenials(root, flags),
  'set-config': (root, flags) => cmdSetConfig(root, flags),
  'check-compat': () => cmdCheckCompat(),
}

/**
 * CLI 入口。
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ code: number, output: string }}
 */
export function run(argv) {
  const { flags, positional } = parseArgs(argv)
  const command = positional[0]
  if (command === undefined || command === 'help' || flags.help !== undefined) {
    return { code: 0, output: HELP }
  }
  const handler = COMMANDS[command]
  if (handler === undefined) return { code: 2, output: `未知命令：${command}\n\n${HELP}` }

  try {
    const root = command === 'check-compat' ? '' : dataRootOf(flags)
    return { code: 0, output: handler(root, flags) }
  } catch (error) {
    return { code: 1, output: `错误：${String(error?.message ?? error)}` }
  }
}

/** 帮助文本。 */
export const HELP = `dsh-auto-review-custom 维护工具 (0.2.0)

用法：node bin/manage.mjs <命令> [选项]

查看：
  doctor        自检数据目录、配置合法性、三档提示词、拒绝记录
  list          列出配置、提示词（全局 / 工作区档 / 会话档）、拒绝记录条数
  check-compat  验证"审查请求识别"是否仍然成立（宿主升级后必跑）

审查拒绝记录（0.2.0 新增）：
  denials [--session <id>] [--cwd <目录>] [--workspace <目录名>]
          [--tool <工具名>] [--kind deny|ask|fail] [--contains <关键字>]
          [--since <ISO 时间>] [--limit <条数>] [--summary]
      读 $DSH_HOME/auto-review/denials.jsonl（新的在前）。
      --cwd 按"该目录或其祖先"匹配；--summary 出按工作区/会话/工具的分布，
      用来决定先给哪个工作区补提示词。

配置：
  set-config [--defaultPreset auto|off] [--prompts on|off] [--allowRules on|off]
      allowRules 控制的是「文件类工具（read/write/edit）静态放行」，
      目标须在沙箱可写根（会话 cwd / /tmp / 系统临时目录）内；
      命令类工具（pwsh 等）永远交给 auto review，不受此开关影响。

提示词（三档，合成顺序：全局 → 工作区 → 会话）：
  set-global --text "..."                          写入全局提示词 prompts/global.md
  set-workspace --path "<绝对路径>" --name <目录名> --text "..."
                                                   写入工作区提示词
                                                   prompts/workspace/<目录名>/note.md
  rm-workspace --name <目录名>                     删除该工作区档目录

  set-session --session <会话id> --text "..."      写入会话级提示词
                                                   prompts/session/<会话id>.md
                                                   传 --text "" 等于删除
  rm-session --session <会话id>                    删除该会话档
  list-sessions                                    列出所有会话档

公共选项：
  --home <目录>   指定 DSH_HOME（缺省读环境变量 DSH_HOME）

提示：提示词文件是 UTF-8 明文 .md，可直接用编辑器改；
      不要用 PowerShell 的 Get-Content | ConvertFrom-Json 改 JSON，
      系统默认编码会把 UTF-8 读坏。一律用本工具。
`
