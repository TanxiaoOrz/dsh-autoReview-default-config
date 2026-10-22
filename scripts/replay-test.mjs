/**
 * 验证「改写 options 后重发」的核心逻辑（不启动 DSH）。
 *
 * 重点验证：
 *   1. 原 options 是冻结的时，改写**不抛错**，且**不改动原对象**；
 *   2. 改写后的新对象里，PROJECT_INSTRUCTIONS 段包含提示词；
 *   3. REPLAY_MARK 标记能防止递归；
 *   4. 提示词为空时不产出新 options。
 *
 * 运行：node scripts/replay-test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { injectPromptIntoReviewText, isReviewRequest, REVIEW_SYSTEM_FINGERPRINT, userMessageText } from '../lib/compat.js'
import { composePrompts } from '../lib/prompts.js'

let fail = 0
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) fail += 1
}

const REPLAY_MARK = Symbol('auto-review-custom.replay')

/** 复刻 index.js 的 rewrittenOptions（保持同步）。 */
function rewrittenOptions(options, dataRoot) {
  const message = options.messages[0]
  const text = userMessageText(message)
  if (text === null) return null

  const composed = composePrompts({ root: dataRoot, presetId: undefined, workspaceId: undefined })
  if (composed.text.length === 0) return null

  const result = injectPromptIntoReviewText(text, composed.text)
  if (!result.ok) return null

  const newMessage = { ...message, content: [{ ...message.content[0], text: result.text }] }
  return {
    ...options,
    messages: [newMessage, ...options.messages.slice(1)],
    [REPLAY_MARK]: true,
  }
}

/** 深度冻结，模拟审查器的 options。 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

function makeRequest() {
  const section = (name, value) => [name, JSON.stringify(value, null, 2)].join('\n\n')
  return {
    provider: 'p',
    model: 'm',
    system: REVIEW_SYSTEM_FINGERPRINT + '\n...',
    temperature: 0,
    signal: undefined,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              section('ENVIRONMENT', { cwd: 'C:\\ws' }),
              section('PROJECT_INSTRUCTIONS', []),
              section('FILTERED_HISTORY', []),
              section('PENDING_ACTION', { name: 'pwsh', arguments: { command: 'pnpm test' } }),
            ].join('\n\n'),
          },
        ],
      },
    ],
  }
}

const root = mkdtempSync(join(tmpdir(), 'arc-replay-'))
mkdirSync(join(root, 'prompts'), { recursive: true })
writeFileSync(join(root, 'prompts', 'global.md'), '本项目使用 pnpm。\n')

console.log('\n[1] 冻结的 options')
const original = deepFreeze(makeRequest())
const originalText = userMessageText(original.messages[0])
check('原 options 确实是冻结的', Object.isFrozen(original) && Object.isFrozen(original.messages[0].content[0]))

let rewritten = null
let threw = null
try {
  rewritten = rewrittenOptions(original, root)
} catch (error) {
  threw = error
}
check('改写冻结对象不抛错', threw === null, threw ? String(threw.message) : '')

console.log('\n[2] 新 options 的内容')
check('产出了新 options', rewritten !== null)
check('新 options 与原对象不是同一个', rewritten !== original)
check('带 REPLAY_MARK 标记', rewritten?.[REPLAY_MARK] === true, '标记缺失会导致无限递归')
check('仍是合法的审查请求（可被识别）', rewritten !== null && isReviewRequest(rewritten))

const newText = rewritten ? userMessageText(rewritten.messages[0]) : ''
const parseSection = (text, name, next) => {
  const start = text.indexOf(`${name}\n\n`) + `${name}\n\n`.length
  const end = text.indexOf(`\n\n${next}`)
  return JSON.parse(text.slice(start, end))
}
const items = newText ? parseSection(newText, 'PROJECT_INSTRUCTIONS', 'FILTERED_HISTORY') : []
check('PROJECT_INSTRUCTIONS 注入了 1 条', items.length === 1, JSON.stringify(items))
check('注入内容正确', items[0]?.content?.[0]?.text?.includes('pnpm') === true)
check('角色是 constraint（只能收窄）', items[0]?.role === 'constraint')

console.log('\n[3] 原对象未被污染')
check('原 messages 仍是同一个数组', original.messages.length === 1)
check('原文本未被改动', userMessageText(original.messages[0]) === originalText)
check(
  '原 PROJECT_INSTRUCTIONS 仍为空数组',
  (() => {
    const before = parseSection(originalText, 'PROJECT_INSTRUCTIONS', 'FILTERED_HISTORY')
    return Array.isArray(before) && before.length === 0
  })(),
)

console.log('\n[4] 其它段未被破坏')
check('ENVIRONMENT 仍在', newText.includes('ENVIRONMENT'))
check('PENDING_ACTION 未被破坏', newText.includes('"name": "pwsh"'))
check('FILTERED_HISTORY 仍在', newText.includes('FILTERED_HISTORY'))

console.log('\n[5] 无提示词时不重发')
const emptyRoot = mkdtempSync(join(tmpdir(), 'arc-empty-'))
mkdirSync(join(emptyRoot, 'prompts'), { recursive: true })
const none = rewrittenOptions(deepFreeze(makeRequest()), emptyRoot)
check('无提示词时返回 null（走原始 next()）', none === null)
rmSync(emptyRoot, { recursive: true, force: true })
rmSync(root, { recursive: true, force: true })

console.log(`\n${'='.repeat(48)}`)
console.log(fail === 0 ? '重发逻辑全部通过' : `失败 ${fail} 项`)
console.log('='.repeat(48))
process.exit(fail === 0 ? 0 : 1)
