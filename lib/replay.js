/**
 * 审查请求的**重发 + 重试**。
 *
 * ## 为什么单独一个模块
 *
 * 这个模块**不依赖任何 Harness 包**（不用 schemastery），所以测试可以直接
 * import 它跑真实实现，不必经过插件入口 `lib/index.js`（那里要解析
 * `@deepseek-ai/schemastery`，而测试是从工作区跑的）。
 *
 * ## 背景
 *
 * 宿主的重试（`dsh-llm-retry/lib/index.js:175`）挂在 `agent/request-error` 上，
 * 只有 agent loop 会派发那个事件（`dsh-agent-loop/lib/index.js:1124`）；
 * 而审查器走的是裸 `ctx.llm.stream()`（`auto-review/lib/index.js:415`），
 * **完全不经过那条路**。结果：同一类瞬时传输错误，主对话会被静默重试最多 5 次，
 * 审查请求却第一次失败就直接 fail-closed，把工具调用杀掉。
 *
 * 既然 `TRANSPORT` 本来就在宿主的默认可重试码列表里
 * （`dsh-llm/lib/types/retry-policy.js:16-22`），这里补一次等价重试是合理的。
 *
 * @module dsh-auto-review-custom/replay
 */

/**
 * 审查器**可重试**的失败码，与宿主 `dsh-llm/lib/types/retry-policy.js` 的
 * 默认可重试集合保持一致（那里 `TRANSPORT / TIMEOUT / SERVER` 都在列表内）。
 */
const RETRYABLE_REVIEW_FAILURES = new Set(['TRANSPORT', 'TIMEOUT', 'SERVER'])

/** 审查请求最大尝试次数（含首次）。 */
const REVIEW_MAX_ATTEMPTS = 3

/** 首次重试前的等待毫秒数；之后翻倍。 */
const REVIEW_RETRY_BASE_MS = 500

/**
 * 用新 options 重新发起审查调用，并在**可重试失败**时自动重试。
 *
 * ## 为什么需要它
 *
 * 宿主的重试（`dsh-llm-retry/lib/index.js:175`）挂在 `agent/request-error` 上，
 * 只有 agent loop 会派发那个事件（`dsh-agent-loop/lib/index.js:1124`）；
 * 而审查器走的是裸 `ctx.llm.stream()`（`auto-review:415`），**完全不经过那条路**。
 *
 * 结果是一个结构性不对称：同一类瞬时传输错误，主对话会被静默重试最多 5 次，
 * 审查请求却第一次失败就直接 fail-closed，把工具调用杀掉。
 * 2026-10-17 实测 1 小时内因此废掉 4 次工具调用，每次重发都立即成功。
 *
 * 既然 `TRANSPORT` 本来就在宿主的可重试码列表里，在这里补一次等价重试是合理的。
 *
 * ## 为什么必须缓冲
 *
 * 失败是以**终止分片**（`finish` + `reason.kind === 'error'`）返回的，不是抛异常。
 * 如果收到错误前已经 yield 了 reasoning 分片，重试会让消费方看到重复的 block index，
 * 破坏 `BlockAssembler`。所以整轮先缓冲，确认成功后才转发。
 * 审查响应很小（一个 JSON 判决），缓冲成本可忽略。
 *
 * ## 安全语义不变
 *
 * 所有尝试都失败时，把最后一次的分片（含错误 finish）原样转发 → 审查器照旧
 * 走 `failed()` → fail-closed 拒绝。**重试只是多给审查器几次机会，不改变最终裁决。**
 *
 * @param {any} llm - `child.llm` 服务实例。
 * @param {any} options - 已改写并带 REPLAY_MARK 的 options。
 * @param {(message: string) => void} [onRetry] - 诊断回调（每次重试调用一次）。
 * @returns {AsyncIterable<any>}
 */
export async function* replayStream(llm, options, onRetry) {
  // 剔除仅供诊断的字段，保持与宿主 options 形状一致。
  const { __scopes, ...clean } = options
  const signal = clean.signal

  for (let attempt = 1; attempt <= REVIEW_MAX_ATTEMPTS; attempt += 1) {
    /** @type {any[]} */
    const buffer = []
    /** @type {string | null} */
    let failureCode = null

    try {
      for await (const chunk of llm.stream(clean)) {
        buffer.push(chunk)
        if (chunk?.type !== 'finish') continue
        if (chunk.reason?.kind === 'error') {
          failureCode = chunk.reason.failure?.code ?? 'UNKNOWN'
        }
        break
      }
    } catch (error) {
      // ⚠️ 抛异常 **不是** 传输失败。
      // `LlmRuntime.stream()` 的契约是：适配器/分发/迭代失败一律规范化为
      // `finish(reason.kind='error')` 分片；能抛到这里的只剩中间件、嵌套调用、
      // 清理或消费方的错误——那是插件 bug，不该盲目重试（会掩盖问题甚至死循环）。
      // 所以这里直接原样抛出，不做任何错误码匹配。
      for (const chunk of buffer) yield chunk
      throw error
    }

    const retryable = failureCode !== null && RETRYABLE_REVIEW_FAILURES.has(failureCode)
    const isLast = attempt >= REVIEW_MAX_ATTEMPTS

    if (!retryable || isLast) {
      // 不重试：把缓冲内容原样交给消费方（含错误 finish）→ 审查器照旧 fail-closed。
      for (const chunk of buffer) yield chunk
      return
    }

    onRetry?.(`review-retry attempt=${attempt}/${REVIEW_MAX_ATTEMPTS} code=${failureCode}`)
    await sleep(REVIEW_RETRY_BASE_MS * 2 ** (attempt - 1), signal)

    if (signal?.aborted === true) {
      // 调用已被取消：不再重试，把这一轮的分片交出去即可。
      for (const chunk of buffer) yield chunk
      return
    }
  }
}

/**
 * 可取消的等待。
 *
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener?.('abort', finish, { once: true })
  })
}
