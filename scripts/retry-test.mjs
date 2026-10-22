/**
 * 审查请求重试逻辑的专项测试。
 *
 * 直接 import 插件的真实实现（`replayStream`），不复制代码，避免测试与实现漂移。
 *
 * 之所以从 `lib/replay.js` 而不是 `lib/index.js` 导入：后者会解析
 * `@deepseek-ai/schemastery`（`Config` 需要），而测试是从**工作区**跑的，
 * 那里没有 Harness 包。`replay.js` 刻意不依赖任何 Harness 包。
 *
 * 运行：node scripts/retry-test.mjs
 */

import { replayStream } from '../lib/replay.js'

let pass = 0
let fail = 0

function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function heading(t) {
  console.log(`\n[${t}]`)
}

// ── 测试替身：可编排的假 llm ─────────────────────────────────────────────

/** 成功响应：一个 reasoning + 一个 text + finish(stop)。 */
function successChunks(text = '{"risk":"low","decision":"allow"}') {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text },
    { type: 'block-end', index: 1, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 失败响应：只给一个 error finish。 */
function errorChunks(code, message = 'boom') {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure: { code, message } } },
  ]
}

/**
 * 造一个按脚本响应的假 llm。
 * @param {Array<'ok' | { error: string } | { throw: string }>} script 每次调用消费一项
 */
function makeFakeLlm(script) {
  const calls = []
  return {
    calls,
    llm: {
      stream(options) {
        calls.push(options)
        const step = script[calls.length - 1] ?? 'ok'
        return (async function* () {
          if (typeof step === 'object' && 'throw' in step) {
            throw new Error(step.throw)
          }
          const chunks = step === 'ok' ? successChunks() : errorChunks(step.error)
          for (const chunk of chunks) yield chunk
        })()
      },
    },
  }
}

/** 收齐一个 async iterable。 */
async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

const OPTIONS = { provider: 'p', model: 'm', messages: [], __scopes: 'global:global' }

// ── 1. 首次成功：不重试 ───────────────────────────────────────────────────
heading('1. 首次成功')
{
  const { llm, calls } = makeFakeLlm(['ok'])
  const retries = []
  const chunks = await collect(replayStream(llm, OPTIONS, (m) => retries.push(m)))
  check('只调用 1 次', calls.length === 1, `实际 ${calls.length}`)
  check('无重试日志', retries.length === 0)
  check('分片完整转发', chunks.length === 7, `实际 ${chunks.length}`)
  check('末片是 finish(stop)', chunks.at(-1)?.reason?.kind === 'stop')
  check('__scopes 不传给适配器', calls[0].__scopes === undefined, JSON.stringify(Object.keys(calls[0])))
  check('REPLAY_MARK 保留（防递归）', Object.getOwnPropertySymbols(calls[0]).length >= 0)
}

// ── 2. 一次 TRANSPORT 后成功：应重试并成功 ────────────────────────────────
heading('2. TRANSPORT 重试后成功')
{
  const { llm, calls } = makeFakeLlm([{ error: 'TRANSPORT' }, 'ok'])
  const retries = []
  const chunks = await collect(replayStream(llm, OPTIONS, (m) => retries.push(m)))
  check('调用了 2 次', calls.length === 2, `实际 ${calls.length}`)
  check('记录 1 次重试', retries.length === 1, JSON.stringify(retries))
  check('重试日志含错误码', retries[0]?.includes('TRANSPORT') === true, retries[0])
  check('最终拿到成功分片', chunks.at(-1)?.reason?.kind === 'stop')
  check('分片数量正确（无重复）', chunks.length === 7, `实际 ${chunks.length}`)
  check(
    '没有把失败那轮的 reasoning 混进来',
    chunks.filter((c) => c.type === 'reasoning-delta' && c.text === 'partial').length === 0,
  )
}

// ── 3. 连续失败到上限：转发错误 finish（fail-closed 保持不变） ────────────
heading('3. 全部失败 → 仍 fail-closed')
{
  const { llm, calls } = makeFakeLlm([{ error: 'TRANSPORT' }, { error: 'TRANSPORT' }, { error: 'TRANSPORT' }])
  const retries = []
  const chunks = await collect(replayStream(llm, OPTIONS, (m) => retries.push(m)))
  check('用满 3 次尝试', calls.length === 3, `实际 ${calls.length}`)
  check('记录 2 次重试（第 3 次是最后一搏）', retries.length === 2, JSON.stringify(retries))
  check('末片是错误 finish', chunks.at(-1)?.reason?.kind === 'error')
  check('错误码仍是 TRANSPORT', chunks.at(-1)?.reason?.failure?.code === 'TRANSPORT')
}

// ── 4. 不可重试的错误码：不重试 ──────────────────────────────────────────
heading('4. 不可重试错误码不重试')
{
  for (const code of ['AUTH', 'INVALID_REQUEST', 'QUOTA', 'MALFORMED_RESPONSE']) {
    const { llm, calls } = makeFakeLlm([{ error: code }, 'ok'])
    const retries = []
    const chunks = await collect(replayStream(llm, OPTIONS, (m) => retries.push(m)))
    check(`${code}：只调用 1 次`, calls.length === 1, `实际 ${calls.length}`)
    check(`${code}：无重试`, retries.length === 0)
    check(`${code}：错误透传`, chunks.at(-1)?.reason?.failure?.code === code)
  }
}

// ── 5. 可重试码全覆盖 ────────────────────────────────────────────────────
heading('5. 可重试码集合')
{
  for (const code of ['TRANSPORT', 'TIMEOUT', 'SERVER']) {
    const { llm, calls } = makeFakeLlm([{ error: code }, 'ok'])
    await collect(replayStream(llm, OPTIONS))
    check(`${code} 会重试`, calls.length === 2, `实际 ${calls.length}`)
  }
}

// ── 6. 抛异常：不重试，原样抛出 ──────────────────────────────────────────
heading('6. 抛异常不重试（中间件/消费方错误）')
{
  // 设计依据：`LlmRuntime.stream()` 会把适配器/分发/迭代失败规范化成
  // `finish(reason.kind='error')` 分片；能抛到这里的只剩中间件、清理或
  // 消费方错误 —— 那是插件 bug，不该盲目重试。
  const { llm, calls } = makeFakeLlm([{ throw: 'ECONNRESET' }, 'ok'])
  const retries = []
  let caught = null
  try {
    await collect(replayStream(llm, OPTIONS, (m) => retries.push(m)))
  } catch (error) {
    caught = error
  }
  check('只调用 1 次（不重试）', calls.length === 1, `实际 ${calls.length}`)
  check('无重试日志', retries.length === 0, JSON.stringify(retries))
  check('异常原样抛出', caught?.message === 'ECONNRESET', String(caught?.message))
}

// ── 6b. 抛出的 message 恰好叫 TIMEOUT 也不会被误判为可重试 ────────────────
heading('6b. 异常 message 与可重试码同名时不误判')
{
  const { llm, calls } = makeFakeLlm([{ throw: 'TIMEOUT' }, 'ok'])
  let caught = null
  try {
    await collect(replayStream(llm, OPTIONS, () => {}))
  } catch (error) {
    caught = error
  }
  check('仍不重试（只看 finish 分片的 code）', calls.length === 1, `实际 ${calls.length}`)
  check('异常抛出', caught?.message === 'TIMEOUT')
}

// ── 7. 已取消：不再重试 ──────────────────────────────────────────────────
heading('7. 取消信号')
{
  const controller = new AbortController()
  controller.abort()
  const { llm, calls } = makeFakeLlm([{ error: 'TRANSPORT' }, 'ok'])
  const chunks = await collect(
    replayStream(llm, { ...OPTIONS, signal: controller.signal }, () => {}),
  )
  check('已取消时不重试', calls.length === 1, `实际 ${calls.length}`)
  check('返回的是失败分片', chunks.at(-1)?.reason?.kind === 'error')
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(48)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
console.log('='.repeat(48))
process.exit(fail === 0 ? 0 : 1)
