/**
 * 0.2.0 新增能力的自测：拒绝记录 + 会话级提示词 + 会话绑定。
 *
 * 用法：node scripts/denial-session-test.mjs
 *
 * 全部是纯逻辑测试，不启动 DSH、不写真实数据目录（用临时目录）。
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendDenial,
  formatDenialLine,
  maskSecrets,
  queryDenials,
  readDenials,
  summarizeArgs,
} from '../lib/denials.js'
import { composePrompts, findWorkspaceId } from '../lib/prompts.js'
import { findWorkspaceDirName } from '../lib/prompt-store.js'
import {
  createSessionBinding,
  listSessionPrompts,
  readSessionPrompt,
  safeSessionId,
  writeSessionPrompt,
} from '../lib/session-prompts.js'

let passed = 0
let failed = 0

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'arc-denial-'))
const dataRoot = join(root, 'auto-review')

try {
  // ── 1. 参数摘要：路径必须保留 ──────────────────────────────────────────
  console.log('\n[1] summarizeArgs —— 关键字段不被截断')
  const longContent = 'x'.repeat(5000)
  const writeArg = summarizeArgs({ content: longContent, file_path: 'D:\\w\\a.txt' })
  check('write 保留 file_path', writeArg.includes('D:\\w\\a.txt'), writeArg.slice(0, 80))
  check('write 摘要不超过上限', writeArg.length <= 400, String(writeArg.length))

  const editArg = summarizeArgs({ old_string: longContent, new_string: longContent, file_path: 'D:\\w\\b.txt' })
  check('edit 保留 file_path', editArg.includes('D:\\w\\b.txt'))

  const cmdArg = summarizeArgs({ command: 'git status' })
  check('command 原样保留', cmdArg === 'git status', cmdArg)

  check('null 参数返回空串', summarizeArgs(null) === '')

  // ── 2. 脱敏 ────────────────────────────────────────────────────────────
  console.log('\n[2] maskSecrets —— 凭据不落盘')
  const masked = maskSecrets('password=hunter2 token=abc123')
  check('key=value 形态被抹掉', !masked.includes('hunter2') && !masked.includes('abc123'), masked)

  const jsonMasked = maskSecrets('{"api_key":"sk-123456","normal":"keepme"}')
  check('JSON 里的 api_key 被抹掉', !jsonMasked.includes('sk-123456'), jsonMasked)
  check('普通字段不被误伤', jsonMasked.includes('keepme'), jsonMasked)

  // ── 3. 写入与读取 ──────────────────────────────────────────────────────
  console.log('\n[3] appendDenial / readDenials')
  appendDenial(dataRoot, {
    kind: 'deny',
    tool: 'pwsh',
    args: { command: 'Remove-Item -Recurse -Force C:\\Windows' },
    reason: 'Auto review denied tool "pwsh": 删除系统目录',
    sessionId: 'sess-a',
    cwd: 'D:\\work\\proj',
    workspace: 'proj-1234abcd',
    callId: 'call_1',
    code: 'AUTO_REVIEW_DENIED',
  })
  appendDenial(dataRoot, {
    kind: 'ask',
    tool: 'pwsh',
    args: { command: 'Get-Content .env' },
    reason: 'Auto review denied tool "pwsh": 读取凭据',
    sessionId: 'sess-b',
    cwd: 'D:\\work\\other',
    workspace: null,
    callId: 'call_2',
    code: 'AUTO_REVIEW_DENIED',
  })

  const all = readDenials(dataRoot)
  check('两条都写入', all.length === 2, String(all.length))
  check('记录含 sessionId', all[0].sessionId === 'sess-a', all[0].sessionId)
  check('记录含 workspace', all[0].workspace === 'proj-1234abcd', String(all[0].workspace))
  check('记录含 reason', typeof all[0].reason === 'string' && all[0].reason.length > 0)
  check('没有凭证泄漏', !JSON.stringify(all).includes('hunter2'))

  // ── 4. 查询过滤 ────────────────────────────────────────────────────────
  console.log('\n[4] queryDenials —— 按会话 / 工作区 / 工具过滤')
  check('按 sessionId 过滤', queryDenials(dataRoot, { sessionId: 'sess-b' }).items.length === 1)
  check('按 kind 过滤', queryDenials(dataRoot, { kind: 'ask' }).items.length === 1)
  check('按 tool 过滤', queryDenials(dataRoot, { tool: 'pwsh' }).items.length === 2)
  check('按 workspace 过滤', queryDenials(dataRoot, { workspace: 'proj-1234abcd' }).items.length === 1)
  check('按 cwd 祖先过滤命中', queryDenials(dataRoot, { cwd: 'D:\\work' }).items.length === 2)
  check('按 cwd 不相关目录过滤为空', queryDenials(dataRoot, { cwd: 'E:\\nope' }).items.length === 0)
  check('按关键字过滤（大小写不敏感）', queryDenials(dataRoot, { contains: '系统目录' }).items.length === 1)
  check('新记录在前', queryDenials(dataRoot, {}).items[0].sessionId === 'sess-b')

  // ── 5. 坏行容错 ────────────────────────────────────────────────────────
  console.log('\n[5] 坏行容错')
  const badRoot = join(root, 'bad')
  mkdirSync(badRoot, { recursive: true })
  writeFileSync(join(badRoot, 'denials.jsonl'), '{"kind":"deny"}\n{坏行\n{"kind":"ask"}\n', 'utf8')
  check('坏行被跳过，好行仍读出', readDenials(badRoot).length === 2, String(readDenials(badRoot).length))

  // ── 6. 会话提示词存储 ──────────────────────────────────────────────────
  console.log('\n[6] 会话提示词读写')
  check('safeSessionId 保留 UUID', safeSessionId('8ab399c5-920f-4d80-a565-a96e715b261d') === '8ab399c5-920f-4d80-a565-a96e715b261d')
  check('safeSessionId 挡住穿越', safeSessionId('../../etc/passwd') === 'etc_passwd', String(safeSessionId('../../etc/passwd')))
  check('safeSessionId 去掉开头点', safeSessionId('.hidden') === 'hidden', String(safeSessionId('.hidden')))
  check('safeSessionId 拒绝空值', safeSessionId('') === null)
  check('safeSessionId 拒绝 ..', safeSessionId('..') === null)

  writeSessionPrompt(dataRoot, 'sess-a', '这个会话允许 pnpm pack')
  check('写入后可读回', readSessionPrompt(dataRoot, 'sess-a').includes('pnpm pack'))
  check('未写入的会话读回空串', readSessionPrompt(dataRoot, 'nobody') === '')
  check('listSessionPrompts 能列出', listSessionPrompts(dataRoot).length === 1)

  writeSessionPrompt(dataRoot, 'sess-a', '')
  check('空串等于删除', readSessionPrompt(dataRoot, 'sess-a') === '')

  writeSessionPrompt(dataRoot, 'sess-a', '# 只有注释\n\n')
  check('只有注释视为空', readSessionPrompt(dataRoot, 'sess-a') === '')

  // ── 7. 三档合成顺序 ────────────────────────────────────────────────────
  console.log('\n[7] composePrompts —— 全局 → 工作区 → 会话')
  mkdirSync(join(dataRoot, 'prompts', 'workspace', 'proj-1234abcd'), { recursive: true })
  writeFileSync(join(dataRoot, 'prompts', 'global.md'), '全局约束\n', 'utf8')
  writeFileSync(
    join(dataRoot, 'prompts', 'workspace', 'proj-1234abcd', 'meta.json'),
    JSON.stringify({ path: 'D:\\work\\proj' }),
    'utf8',
  )
  writeFileSync(join(dataRoot, 'prompts', 'workspace', 'proj-1234abcd', 'note.md'), '工作区约束\n', 'utf8')
  writeSessionPrompt(dataRoot, 'sess-a', '会话约束')

  const composed = composePrompts({ root: dataRoot, cwd: 'D:\\work\\proj\\sub', sessionId: 'sess-a' })
  check('三段都在', composed.parts.length === 3, JSON.stringify(composed.parts.map((p) => p.scope)))
  check('顺序为 global→workspace→session', JSON.stringify(composed.parts.map((p) => p.scope)) === '["global","workspace","session"]')
  check('文本含三段标题前缀', composed.text.includes('[global:global]') && composed.text.includes('[workspace:proj-1234abcd]') && composed.text.includes('[session:sess-a]'))

  const noSession = composePrompts({ root: dataRoot, cwd: 'D:\\work\\proj' })
  check('无会话绑定时不注入会话档', noSession.parts.length === 2, JSON.stringify(noSession.parts.map((p) => p.scope)))

  // ── 8. 工作区 id 反查（无 note.md 也要能答）────────────────────────────
  console.log('\n[8] findWorkspaceId —— 无提示词也能定位工作区')
  const noNote = join(dataRoot, 'prompts', 'workspace', 'bare-99999999')
  mkdirSync(noNote, { recursive: true })
  writeFileSync(join(noNote, 'meta.json'), JSON.stringify({ path: 'D:\\work\\bare' }), 'utf8')
  const found = findWorkspaceId(dataRoot, 'D:\\work\\bare\\deep')
  check('无 note.md 仍能匹配', found !== null && found.id === 'bare-99999999', JSON.stringify(found))

  // ── 9. 会话绑定槽 ──────────────────────────────────────────────────────
  console.log('\n[9] createSessionBinding —— 按 cwd 隔离 + TTL')
  const binding = createSessionBinding(50)
  binding.bind('D:\\work\\proj', 'sess-a')
  check('同 cwd 可解析', binding.resolve('D:\\work\\proj') === 'sess-a')
  check('大小写不敏感', binding.resolve('d:\\WORK\\proj') === 'sess-a')
  check('别的 cwd 不串', binding.resolve('D:\\work\\other') === null)
  check('未绑定的 cwd 返回 null', binding.resolve('E:\\x') === null)

  await new Promise((resolve) => setTimeout(resolve, 80))
  check('TTL 过期后返回 null', binding.resolve('D:\\work\\proj') === null)

  binding.bind('D:\\work\\proj', 'sess-a')
  binding.bind('D:\\work\\proj', 'sess-new')
  check('同 cwd 后绑覆盖前绑', binding.resolve('D:\\work\\proj') === 'sess-new')
  binding.clear()
  check('clear 后为空', binding.resolve('D:\\work\\proj') === null)

  // ── 10. 格式化 ─────────────────────────────────────────────────────────
  console.log('\n[10] formatDenialLine')
  const line = formatDenialLine(all[0])
  check('含 kind 与工作区', line.includes('[deny]') && line.includes('proj-1234abcd'), line)
  check('未匹配工作区有明确文案', formatDenialLine({ kind: 'ask', tool: 'pwsh', workspace: null, reason: 'r', t: 'now' }).includes('未匹配工作区'))

  // ── 11. 页签依赖的按路径读取（readWorkspacePrompt 的底层）─────────────
  console.log('\n[11] 按工作区路径定位与读取（页签用）')
  const byPath = findWorkspaceDirName(dataRoot, 'D:\\work\\proj')
  check('按路径能定位目录名', byPath === 'proj-1234abcd', String(byPath))
  check('大小写不敏感', findWorkspaceDirName(dataRoot, 'd:\\WORK\\proj') === 'proj-1234abcd')
  check('未登记的路径返回 null', findWorkspaceDirName(dataRoot, 'D:\\nope') === null)

  // 读回该档正文（与页签 readWorkspacePrompt 走同一条文件路径）
  const notePath = join(dataRoot, 'prompts', 'workspace', 'proj-1234abcd', 'note.md')
  check('工作区档文件存在', existsSync(notePath))
  check('正文含工作区约束', readFileSync(notePath, 'utf8').includes('工作区约束'))

  // ── 12. cwd 查询与工作区 scope 对齐（页签两种 scope 的过滤结果）───────
  console.log('\n[12] 拒绝记录的 scope 过滤与页签一致')
  appendDenial(dataRoot, {
    kind: 'deny',
    tool: 'write',
    args: { file_path: 'D:\\work\\proj\\a.txt' },
    reason: '测试：工作区内被拒',
    sessionId: 'sess-a',
    cwd: 'D:\\work\\proj',
    workspace: 'proj-1234abcd',
    callId: 'call_x',
    code: 'AUTO_REVIEW_DENIED',
  })
  const bySession = queryDenials(dataRoot, { sessionId: 'sess-a' })
  const byCwd = queryDenials(dataRoot, { cwd: 'D:\\work\\proj' })
  check('本会话 scope 能取到', bySession.items.length >= 1, String(bySession.items.length))
  check('本工作区 scope 能取到', byCwd.items.length >= 1, String(byCwd.items.length))
  check('工作区 scope 走 cwd 前缀匹配', byCwd.items.every((item) => String(item.cwd ?? '').toLowerCase().startsWith('d:\\work\\proj')))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('\n================================================')
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
console.log('================================================')
if (failed > 0) process.exit(1)
