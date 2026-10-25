/**
 * 按会话 id 反查它的**工作目录**。
 *
 * ## 为什么单独一个模块
 *
 * 逻辑不长，但它是页签"当前工作区"能否加载/保存的**唯一前提**，而且依赖
 * 宿主三类服务的实际行为差异。抽出来才能用 mock ctx 做纯 Node 单测
 * （`lib/index.js` 要 import `schemastery`，测试不碰它）。
 *
 * ## 为什么先查缓存（这是根因修复）
 *
 * 实测（2026-10-25，0.2.0 首版，宿主 0.2.0-rc.2）：`ctx.agents.get(id)` 拿到的
 * `Agent` **没有** `.session` 字段——`agents` 服务的类型契约里
 * `Agent` 只有 `{ readonly id: SessionId }`（Host
 * `Service.listService('agents')` 的 referencedTypes 可查）。于是
 * `agent.session.header.cwd` 恒为 `undefined`，页签里 cwd 永远是 `null`，
 * 「当前工作区」输入框被禁用、保存按钮点不动——正是实机反馈的症状。
 *
 * 而 `tools/pre-execute` 里的 `exec.agent.session.header.cwd` **一直是对的**
 * （静态放行的 probe 记录里始终有真实路径）。所以由调用方在 pre-execute
 * 阶段把 `sessionId → cwd` 写进缓存，是唯一经过验证的来源。
 *
 * ## 三层顺序
 *
 * | 顺序 | 来源 | 覆盖场景 |
 * |---|---|---|
 * | ① | 缓存（`pre-execute` 写入） | 本会话调用过工具（绝大多数情况） |
 * | ② | `workspaceRegistry.list()` 的 `sessionIds` 归属 | 会话还没调工具，但已登记到工作区 |
 * | ③ | `agents.get(id)` 的 `session.header.cwd` | 厂商将来补上该字段时自动生效 |
 *
 * 任何一层抛错都继续往下试；最后返回 `{ cwd: null, via, diag }`。
 * `via` 记录**哪一层命中**、`diag` 记录每层的探测结果——这是排查
 * "页签里目录显示为 —" 时唯一能定位根因的信息。
 *
 * @module dsh-auto-review-custom/session-cwd
 */

/**
 * 反查会话的工作目录。
 *
 * @param {any} ctx - Host 上下文（用 `ctx.get(name)` 取服务，取不到也不抛）。
 * @param {string} sessionId
 * @param {Map<string, string>} [cache] - `sessionId → cwd`，由 `tools/pre-execute` 写入。
 * @returns {{ cwd: string | null, via: 'cache'|'registry'|'agents'|'none'|'empty-id', diag: { registry: string, agents: string } }}
 */
export function findSessionCwd(ctx, sessionId, cache) {
  /** @type {{ registry: string, agents: string }} */
  const diag = { registry: '-', agents: '-' }
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { cwd: null, via: 'empty-id', diag }
  }

  // ① 缓存（pre-execute 写入，最可靠）。
  //
  // 注意用 `cache != null`：只判 `!== undefined` 会让显式传入的 `null` 走到
  // `null.get(...)` 上抛 TypeError（测试已覆盖这个形态）。
  if (cache != null && typeof cache.get === 'function') {
    const cached = cache.get(sessionId)
    if (typeof cached === 'string' && cached !== '') {
      return { cwd: cached, via: 'cache', diag }
    }
  }

  // ② 已注册工作区的 sessionIds 归属。
  //
  // `sessionIds` 是**getter**（宿主文档明说它按 canonical-cwd 头部索引过滤），
  // 访问它本身可能抛，所以单独 try。
  try {
    const registry = ctx?.get?.('workspaceRegistry') ?? ctx?.workspaceRegistry
    const list = typeof registry?.list === 'function' ? registry.list() : []
    if (!Array.isArray(list)) {
      diag.registry = 'not-array'
    } else {
      diag.registry = `${list.length}ws`
      for (const workspace of list) {
        let ids
        try {
          ids = workspace?.sessionIds
        } catch {
          continue
        }
        if (!Array.isArray(ids) || !ids.includes(sessionId)) continue
        const path = workspace?.path
        if (typeof path === 'string' && path !== '') {
          return { cwd: path, via: 'registry', diag }
        }
      }
    }
  } catch (error) {
    diag.registry = `throw:${String(error?.message ?? error).slice(0, 80)}`
  }

  // ③ 活跃 agent（类型上 Agent 只有 id；运行时若带 session 就白拿）。
  try {
    const agents = ctx?.get?.('agents') ?? ctx?.agents
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    if (agent === undefined) {
      diag.agents = 'no-agent'
    } else {
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') {
        diag.agents = 'has-cwd'
        return { cwd, via: 'agents', diag }
      }
      diag.agents = 'agent-without-session'
    }
  } catch (error) {
    diag.agents = `throw:${String(error?.message ?? error).slice(0, 80)}`
  }

  return { cwd: null, via: 'none', diag }
}
