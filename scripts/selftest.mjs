/**
 * 自测：不启动 DSH，纯 Node 喂假数据验证全部纯逻辑。
 *
 * 运行：node scripts/selftest.mjs
 * 退出码 0 = 全通过。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  REVIEW_SYSTEM_FINGERPRINT,
  injectPromptIntoReviewText,
  isReviewRequest,
} from '../lib/compat.js'
import { decide, isPathUnder, writableRootsFor } from '../lib/rules.js'
import { composePrompts } from '../lib/prompts.js'
import { parseConfig } from '../lib/config.js'

let pass = 0
let fail = 0

/**
 * 一条断言。
 * @param {string} label
 * @param {boolean} condition
 * @param {string} [detail]
 */
function check(label, condition, detail) {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 一条异步断言。 */
async function acheck(label, thunk) {
  let result
  try {
    result = await thunk()
  } catch (error) {
    fail += 1
    console.log(`  FAIL  ${label} — 抛错：${String(error?.message ?? error)}`)
    return
  }
  check(label, result)
}

let section = 0
function heading(title) {
  section += 1
  console.log(`\n[${section}] ${title}`)
}

/** 造一条审查请求样例。 */
function reviewRequest({ action = { name: 'pwsh', arguments: { command: 'git status' } }, projectInstructions = [] } = {}) {
  return {
    provider: 'p',
    model: 'm',
    system: `${REVIEW_SYSTEM_FINGERPRINT}\n...rest...`,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              'ENVIRONMENT',
              JSON.stringify({ cwd: 'C:\\ws' }, null, 2),
              'PROJECT_INSTRUCTIONS',
              JSON.stringify(projectInstructions, null, 2),
              'FILTERED_HISTORY',
              '[]',
              'PENDING_ACTION',
              JSON.stringify({ name: action.name, description: 'd', parameters: {}, arguments: action.arguments }, null, 2),
            ].join('\n\n'),
          },
        ],
      },
    ],
  }
}

// ── 1. 审查请求识别 ──────────────────────────────────────────────────────
heading('审查请求识别')
check('正例：标准审查请求被识别', isReviewRequest(reviewRequest()) === true)
check(
  '反例：主对话请求（无 system）不被识别',
  isReviewRequest({ provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }) === false,
)
check(
  '反例：system 只是普通内容',
  isReviewRequest({ provider: 'p', model: 'm', system: 'You are a coding agent', messages: [{ role: 'user', content: [{ type: 'text', text: 'PROJECT_INSTRUCTIONS PENDING_ACTION' }] }] }) === false,
)
check(
  '反例：多条消息（主对话特征）',
  isReviewRequest({
    provider: 'p',
    model: 'm',
    system: REVIEW_SYSTEM_FINGERPRINT,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a PROJECT_INSTRUCTIONS PENDING_ACTION' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
    ],
  }) === false,
)
check('反例：null / 非对象不抛错', isReviewRequest(null) === false && isReviewRequest(42) === false)

// ── 2. 提示词注入 ────────────────────────────────────────────────────────
heading('PROJECT_INSTRUCTIONS 注入')
{
  const req = reviewRequest()
  const text = req.messages[0].content[0].text
  const result = injectPromptIntoReviewText(text, '本项目测试用 pnpm')
  check('注入成功', result.ok === true, result.ok ? '' : result.reason)
  if (result.ok) {
    const items = JSON.parse(
      result.text.slice(
        result.text.indexOf('PROJECT_INSTRUCTIONS\n\n') + 'PROJECT_INSTRUCTIONS\n\n'.length,
        result.text.indexOf('\n\nFILTERED_HISTORY'),
      ),
    )
    check('注入后仍是合法 JSON 数组', Array.isArray(items))
    check('追加了 1 个条目', items.length === 1)
    check('role 是 constraint（只能收窄，符合 REVIEW_POLICY）', items[0].role === 'constraint')
    check('内容正确', items[0].content[0].text === '本项目测试用 pnpm')
    check('其它段没被破坏', result.text.includes('PENDING_ACTION') && result.text.includes('FILTERED_HISTORY'))
  }

  const missing = injectPromptIntoReviewText('没有锚点的文本', 'x')
  check('缺锚点时返回 ok:false 而不是抛错', missing.ok === false)
}

// ── 3. 提示词合成（全局 + 工作区） ───────────────────────────────────────
heading('提示词合成：全局 + 工作区')
{
  const root = mkdtempSync(join(tmpdir(), 'arc-'))
  mkdirSync(join(root, 'prompts', 'workspace'), { recursive: true })
  writeFileSync(join(root, 'prompts', 'global.md'), '# 注释行\n全局提示词\n')
  const wsDir = join(root, 'prompts', 'workspace', 'ws-hash')
  mkdirSync(wsDir, { recursive: true })
  writeFileSync(join(wsDir, 'note.md'), '工作区提示词\n')

  const globalOnly = composePrompts({ root, cwd: undefined })
  check('只有全局档时合成 1 段', globalOnly.parts.length === 1 && globalOnly.text.includes('全局提示词'))
  check('注释行被剔除', !globalOnly.text.includes('注释行'))

  const withWs = composePrompts({ root, cwd: 'D:\\some\\workspace' })
  check('给了 cwd 仍只产出全局（无匹配工作区文件）', withWs.parts.length === 1, JSON.stringify(withWs.parts))

  const full = composePrompts({ root: join(root, 'nope'), cwd: undefined })
  check('目录不存在时不抛错', full.text === '')

  rmSync(root, { recursive: true, force: true })
}

// ── 4. 静态放行判定（沙箱等价） ──────────────────────────────────────────
heading('静态放行：文件类工具 + 沙箱等价路径判定')
{
  const workspace = mkdtempSync(join(tmpdir(), 'arc-ws-'))
  const inside = join(workspace, 'sub', 'a.txt')
  mkdirSync(dirname(inside), { recursive: true })
  writeFileSync(inside, 'x')

  const outside = mkdtempSync(join(tmpdir(), 'arc-out-'))

  await acheck('工作区内文件 → allow', async () => {
    const v = await decide({ toolName: 'write', args: { file_path: inside }, cwd: workspace })
    return v.action === 'allow'
  })
  await acheck('工作区内不存在的文件 → allow（新建）', async () => {
    const v = await decide({ toolName: 'write', args: { file_path: join(workspace, 'new.txt') }, cwd: workspace })
    return v.action === 'allow'
  })
  // ── 注意：测试工作区建在 tmpdir() 下，而 tmpdir() 本身就是沙箱可写根 ──
  // 因此"工作区外"的用例不能靠另建一个 tmp 子目录，必须用**明确不在任何
  // 可写根内**的路径。Windows 下用系统目录，其它平台用 /etc 之类。
  const definitelyOutside = process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'Temp', 'arc-outside-x.txt')
    : '/etc/arc-outside-x.txt'

  await acheck('工作区外（不在任何可写根）→ review', async () => {
    const v = await decide({ toolName: 'write', args: { file_path: definitelyOutside }, cwd: workspace })
    return v.action === 'review'
  })
  await acheck('父目录穿越（tmp/../..）→ review', async () => {
    // tmpdir 的上一级不是可写根，因此穿越两级即可跳出
    const escaped = join(workspace, '..', '..', '..', 'escape.txt')
    const v = await decide({ toolName: 'write', args: { file_path: escaped }, cwd: workspace })
    return v.action === 'review'
  })
  await acheck('绝对路径在区外 → review', async () => {
    const v = await decide({ toolName: 'read', args: { file_path: definitelyOutside }, cwd: workspace })
    return v.action === 'review'
  })
  await acheck('read 在工作区内 → allow', async () => {
    const v = await decide({ toolName: 'read', args: { file_path: inside }, cwd: workspace })
    return v.action === 'allow'
  })
  await acheck('edit 在工作区内 → allow', async () => {
    const v = await decide({ toolName: 'edit', args: { file_path: inside }, cwd: workspace })
    return v.action === 'allow'
  })
  await acheck('命令类工具一律 review（无静态放行）', async () => {
    const v = await decide({ toolName: 'pwsh', args: { command: 'git status' }, cwd: workspace })
    return v.action === 'review'
  })
  await acheck('危险命令也交回 AI（不做静态底线）', async () => {
    const v = await decide({ toolName: 'pwsh', args: { command: 'Remove-Item -Recurse -Force C:\\Windows' }, cwd: workspace })
    return v.action === 'review'
  })
  await acheck('临时目录算可写根（与沙箱一致）', async () => {
    const v = await decide({ toolName: 'write', args: { file_path: join(tmpdir(), 'arc-tmp-x.txt') }, cwd: workspace })
    return v.action === 'allow'
  })
  await acheck('未知工具（无 file_path）→ review', async () => {
    const v = await decide({ toolName: 'web_fetch', args: { url: 'http://x' }, cwd: workspace })
    return v.action === 'review'
  })
  await acheck('无 cwd 时用进程 cwd，仍能判定', async () => {
    const v = await decide({ toolName: 'write', args: { file_path: 'C:\\definitely\\outside\\x.txt' }, cwd: undefined })
    return v.action === 'review'
  })

  // 路径包含性底层（纯词法用例，不依赖文件是否存在）
  // 注意：isPathUnder 是 async，必须 await 之后再比较，否则 Promise === true 恒为 false。
  await acheck('isPathUnder：自身', async () => (await isPathUnder(workspace, workspace)) === true)
  await acheck('isPathUnder：子路径', async () => (await isPathUnder(inside, workspace)) === true)
  await acheck('isPathUnder：亲戚路径不匹配', async () => (await isPathUnder(workspace + '-evil', workspace)) === false)
  await acheck('isPathUnder：父目录不匹配', async () => (await isPathUnder(join(workspace, '..'), workspace)) === false)

  if (process.platform === 'win32') {
    await acheck('isPathUnder：Windows 大小写不敏感', async () => (await isPathUnder(inside.toUpperCase(), workspace)) === true)
  }

  const roots = writableRootsFor(workspace)
  check('可写根包含工作区', roots.some((r) => resolve(r) === resolve(workspace)))
  check('可写根包含 tmpdir', roots.some((r) => resolve(r) === resolve(tmpdir())))

  rmSync(workspace, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}

// ── 5. 配置解析 ──────────────────────────────────────────────────────────
heading('配置解析')
{
  check('缺省配置全关', parseConfig('{}').defaultPreset === 'off')
  check('defaultPreset=auto 被接受', parseConfig('{"defaultPreset":"auto"}').defaultPreset === 'auto')
  check('非法 defaultPreset 回落 off', parseConfig('{"defaultPreset":"nonsense"}').defaultPreset === 'off')
  check('prompts=false 生效', parseConfig('{"prompts":false}').prompts === false)
  check('非法 JSON 抛错（由上层保留上一版）', (() => { try { parseConfig('{bad'); return false } catch { return true } })())
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(48)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
console.log('='.repeat(48))
process.exit(fail === 0 ? 0 : 1)
