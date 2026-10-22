/**
 * 端到端模拟：用真实形状的请求验证插件新架构的两条路径。
 *
 * 不启动 DSH——直接调用插件的纯逻辑，验证：
 *   A. 静态放行（文件类工具 + 沙箱等价路径判定）
 *   B. 命令类工具一律交回 AI
 *   C. 提示词：全局 + 工作区（含"最具体优先"）
 *   D. 审查请求注入
 *   E. 非审查请求零影响
 *
 * 运行：node scripts/e2e-sim.mjs
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  REVIEW_SYSTEM_FINGERPRINT,
  injectPromptIntoReviewText,
  isReviewRequest,
  userMessageText,
} from '../lib/compat.js'
import {
  composePrompts,
  cwdOfReviewText,
  WORKSPACE_META_FILE,
  WORKSPACE_PROMPT_FILE,
} from '../lib/prompts.js'
import { decide } from '../lib/rules.js'

let fail = 0
/**
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) fail += 1
}

/** 造一条真实形状的审查请求。 */
function makeReviewRequest(cwd, toolName, args) {
  const section = (name, value) => [name, JSON.stringify(value, null, 2)].join('\n\n')
  return {
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    system: REVIEW_SYSTEM_FINGERPRINT + '\n\n...（REVIEW_POLICY 其余部分）...',
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              section('ENVIRONMENT', { cwd }),
              section('PROJECT_INSTRUCTIONS', []),
              section('FILTERED_HISTORY', []),
              section('PENDING_ACTION', {
                name: toolName,
                description: 'd',
                parameters: { type: 'object' },
                arguments: args,
              }),
            ].join('\n\n'),
          },
        ],
      },
    ],
  }
}

/** 读回注入后的 PROJECT_INSTRUCTIONS 数组。 */
function readPrompts(options) {
  const text = userMessageText(options.messages[0])
  const marker = 'PROJECT_INSTRUCTIONS\n\n'
  const start = text.indexOf(marker) + marker.length
  const end = text.indexOf('\n\nFILTERED_HISTORY')
  return JSON.parse(text.slice(start, end))
}

// ── 准备数据目录 ─────────────────────────────────────────────────────────
const dataRoot = mkdtempSync(join(tmpdir(), 'arc-e2e-'))
mkdirSync(join(dataRoot, 'prompts'), { recursive: true })
writeFileSync(join(dataRoot, 'prompts', 'global.md'), '全局：本项目使用 pnpm。\n')

// 父工作区 与 更具体的子工作区（验证"最具体优先"）
const parentWs = mkdtempSync(join(tmpdir(), 'arc-parent-'))
const childWs = join(parentWs, 'child')
mkdirSync(childWs, { recursive: true })

const wsRoot = join(dataRoot, 'prompts', 'workspace')
for (const [name, path, text] of [
  ['parent', parentWs, '父工作区提示词'],
  ['child', childWs, '子工作区提示词'],
]) {
  const dir = join(wsRoot, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, WORKSPACE_PROMPT_FILE), `${text}\n`)
  writeFileSync(join(dir, WORKSPACE_META_FILE), JSON.stringify({ path }, null, 2))
}

console.log('\n[A] 静态放行：文件类工具')
{
  const inside = join(parentWs, 'a.txt')
  writeFileSync(inside, 'x')

  const allow = await decide({ toolName: 'write', args: { file_path: inside }, cwd: parentWs })
  check('工作区内 write → allow', allow.action === 'allow', JSON.stringify(allow))

  const readAllow = await decide({ toolName: 'read', args: { file_path: inside }, cwd: parentWs })
  check('工作区内 read → allow', readAllow.action === 'allow')

  const editAllow = await decide({ toolName: 'edit', args: { file_path: inside }, cwd: parentWs })
  check('工作区内 edit → allow', editAllow.action === 'allow')

  const newFile = await decide({ toolName: 'write', args: { file_path: join(parentWs, 'new.txt') }, cwd: parentWs })
  check('工作区内新建文件 → allow', newFile.action === 'allow')

  const outside = process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'Temp', 'arc-out-x.txt')
    : '/etc/arc-out-x.txt'
  const deny = await decide({ toolName: 'write', args: { file_path: outside }, cwd: parentWs })
  check('工作区外 write → review', deny.action === 'review', JSON.stringify(deny))

  const traverse = await decide({
    toolName: 'write',
    args: { file_path: join(parentWs, '..', '..', '..', 'escape.txt') },
    cwd: parentWs,
  })
  check('父目录穿越 → review', traverse.action === 'review')
}

console.log('\n[B] 命令类工具一律交回 AI')
{
  for (const command of ['git status', 'pnpm test', 'Remove-Item -Recurse -Force C:\\Windows', 'npm publish']) {
    const v = await decide({ toolName: 'pwsh', args: { command }, cwd: parentWs })
    check(`pwsh "${command.slice(0, 30)}" → review`, v.action === 'review')
  }
}

console.log('\n[C] 提示词：全局 + 工作区')
{
  const globalOnly = composePrompts({ root: dataRoot, cwd: undefined })
  check('无 cwd 时只有全局档', globalOnly.parts.length === 1 && globalOnly.text.includes('pnpm'))

  const parentHit = composePrompts({ root: dataRoot, cwd: parentWs })
  check('父工作区命中父档（2 段）', parentHit.parts.length === 2, JSON.stringify(parentHit.parts))
  check('父档内容正确', parentHit.text.includes('父工作区提示词'))

  const childHit = composePrompts({ root: dataRoot, cwd: childWs })
  check('子工作区命中最具体的档', childHit.text.includes('子工作区提示词'), JSON.stringify(childHit.parts))
  check('子工作区不再叠加父档文案（取最具体）', !childHit.text.includes('父工作区提示词'))
  check('全局档始终在前', childHit.text.indexOf('pnpm') < childHit.text.indexOf('子工作区提示词'))

  const other = composePrompts({ root: dataRoot, cwd: tmpdir() })
  check('无关 cwd 只命中全局', other.parts.length === 1, JSON.stringify(other.parts))
}

console.log('\n[D] 审查请求注入')
{
  const req = makeReviewRequest(parentWs, 'pwsh', { command: 'pnpm test' })
  check('请求被识别为审查请求', isReviewRequest(req))

  const text = userMessageText(req.messages[0])
  check('能从 ENVIRONMENT 段取到 cwd', cwdOfReviewText(text) === parentWs, cwdOfReviewText(text))

  const composed = composePrompts({ root: dataRoot, cwd: cwdOfReviewText(text) })
  const result = injectPromptIntoReviewText(text, composed.text)
  check('注入成功', result.ok, result.ok ? '' : result.reason)

  req.messages[0].content[0].text = result.text
  const items = readPrompts(req)
  check('注入 1 条', items.length === 1, JSON.stringify(items))
  check('角色为 constraint', items[0]?.role === 'constraint')

  const injected = items[0]?.content?.[0]?.text ?? ''
  check('包含全局档文案', injected.includes('pnpm'))
  check('包含工作区档文案', injected.includes('父工作区提示词'))

  const action = JSON.parse(userMessageText(req.messages[0]).split('\n\nPENDING_ACTION\n\n')[1])
  check('PENDING_ACTION 未被破坏', action.name === 'pwsh' && action.arguments.command === 'pnpm test')
}

console.log('\n[E] 非审查请求零影响')
{
  const mainConversation = {
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }] },
      { role: 'user', content: [{ type: 'text', text: '帮我改代码' }] },
    ],
  }
  check('主对话请求不被识别', isReviewRequest(mainConversation) === false)
  check('cwdOfReviewText 对非审查文本返回 undefined', cwdOfReviewText('随便一段没有 ENVIRONMENT 的文本') === undefined)
}

rmSync(dataRoot, { recursive: true, force: true })
rmSync(parentWs, { recursive: true, force: true })

console.log(`\n${'='.repeat(48)}`)
console.log(fail === 0 ? '端到端模拟全部通过' : `失败 ${fail} 项`)
console.log('='.repeat(48))
process.exit(fail === 0 ? 0 : 1)
