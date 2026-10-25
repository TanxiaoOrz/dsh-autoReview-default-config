/**
 * `lib/session-cwd.js` 的自测：会话 → cwd 的三层反查。
 *
 * 用法：node scripts/session-cwd-test.mjs
 *
 * 为什么单独测这个：它是"页签里当前工作区能否加载/保存"的唯一前提。
 * 0.2.0 首版就在这一步错了（用了 `agents.get(id).session.header.cwd`，
 * 而 `Agent` 类型上只有 `id`），表现为"目录显示 —、输入框全灰"。
 */

import { findSessionCwd } from '../lib/session-cwd.js'

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

/** 造一个假 ctx：只实现 `get`，按需返回服务。 */
function fakeCtx(services) {
  return { get: (name) => services[name] }
}

/** 造一个假工作区。 */
function fakeWorkspace(path, sessionIds) {
  return { path, sessionIds }
}

const SID = 'session-006b9a21-2a19-4696-af04-3bf901b5c50e'

// ── 1. 空 id ────────────────────────────────────────────────────────────
console.log('\n[1] 空 sessionId')
{
  const r = findSessionCwd(fakeCtx({}), '', new Map())
  check('返回 null', r.cwd === null)
  check('via 标记 empty-id', r.via === 'empty-id', r.via)
}

// ── 2. 缓存优先（核心修复）──────────────────────────────────────────────
console.log('\n[2] 缓存层（pre-execute 写入）')
{
  const cache = new Map([[SID, 'D:\\Program Code\\plugins\\AutoReviewCustom']])
  const r = findSessionCwd(fakeCtx({}), SID, cache)
  check('命中缓存', r.cwd === 'D:\\Program Code\\plugins\\AutoReviewCustom', String(r.cwd))
  check('via=cache', r.via === 'cache', r.via)
}
{
  // 缓存命中时即使 registry 也有值，也优先用缓存（它来自真实 exec）。
  const cache = new Map([[SID, 'D:\\from\\cache']])
  const ctx = fakeCtx({ workspaceRegistry: { list: () => [fakeWorkspace('D:\\from\\registry', [SID])] } })
  const r = findSessionCwd(ctx, SID, cache)
  check('缓存优先于 registry', r.cwd === 'D:\\from\\cache', String(r.cwd))
}

// ── 3. registry 兜底 ────────────────────────────────────────────────────
console.log('\n[3] workspaceRegistry 兜底')
{
  const ctx = fakeCtx({ workspaceRegistry: { list: () => [fakeWorkspace('D:\\Program Code\\plugins', [SID])] } })
  const r = findSessionCwd(ctx, SID, new Map())
  check('命中 registry', r.cwd === 'D:\\Program Code\\plugins', String(r.cwd))
  check('via=registry', r.via === 'registry', r.via)
}
{
  // registry 里有别的会话，不该被串到本会话。
  const ctx = fakeCtx({ workspaceRegistry: { list: () => [fakeWorkspace('D:\\other', ['session-other'])] } })
  const r = findSessionCwd(ctx, SID, new Map())
  check('不串到其它会话', r.cwd === null, String(r.cwd))
}
{
  // sessionIds 是 getter，访问抛错也不能炸整体。
  const ctx = fakeCtx({
    workspaceRegistry: {
      list: () => [
        {
          path: 'D:\\broken',
          get sessionIds() {
            throw new Error('getter boom')
          },
        },
      ],
    },
  })
  const r = findSessionCwd(ctx, SID, new Map())
  check('sessionIds getter 抛错不影响', r.cwd === null)
  check('诊断记录了 registry 次数', typeof r.diag.registry === 'string' && r.diag.registry.length > 0, r.diag.registry)
}

// ── 4. agents 层（类型上没有 session，但保留探测）────────────────────────
console.log('\n[4] agents 层')
{
  // 真实情况：Agent 只有 id（没有 session）→ 必须优雅失败。
  const ctx = fakeCtx({ agents: { get: () => ({ id: SID }) } })
  const r = findSessionCwd(ctx, SID, new Map())
  check('Agent 无 session 时返回 null', r.cwd === null, String(r.cwd))
  check('诊断标出 agent-without-session', r.diag.agents === 'agent-without-session', r.diag.agents)
}
{
  // 厂商将来若补上 session.header.cwd，应自动生效。
  const ctx = fakeCtx({ agents: { get: () => ({ id: SID, session: { header: { cwd: 'D:\\from\\agent' } } }) } })
  const r = findSessionCwd(ctx, SID, new Map())
  check('Agent 带 session 时命中', r.cwd === 'D:\\from\\agent', String(r.cwd))
  check('via=agents', r.via === 'agents', r.via)
}
{
  const ctx = fakeCtx({ agents: { get: () => undefined } })
  const r = findSessionCwd(ctx, SID, new Map())
  check('agent 不存在时返回 null', r.cwd === null)
  check('诊断标出 no-agent', r.diag.agents === 'no-agent', r.diag.agents)
}

// ── 5. 服务缺失 / 异常 ──────────────────────────────────────────────────
console.log('\n[5] 服务缺失与异常')
{
  const r = findSessionCwd(fakeCtx({}), SID, new Map())
  check('所有服务缺失 → null', r.cwd === null)
  check('via=none', r.via === 'none', r.via)
}
{
  const ctx = { get: () => { throw new Error('ctx boom') } }
  const r = findSessionCwd(ctx, SID, new Map())
  check('ctx.get 抛错不外泄', r.cwd === null)
  check('via=none', r.via === 'none', r.via)
}
{
  const r = findSessionCwd(undefined, SID, new Map())
  check('ctx 为 undefined 不外泄', r.cwd === null)
}
{
  // cache 传 null / 缺方法也应安全。
  const ctx = fakeCtx({ workspaceRegistry: { list: () => [fakeWorkspace('D:\\x', [SID])] } })
  check('cache=null 仍走 registry', findSessionCwd(ctx, SID, null).cwd === 'D:\\x')
  check('cache 缺 get 仍走 registry', findSessionCwd(ctx, SID, {}).cwd === 'D:\\x')
}

// ── 6. 空字符串不当作有效值 ─────────────────────────────────────────────
console.log('\n[6] 空值不算命中')
{
  const cache = new Map([[SID, '']])
  const ctx = fakeCtx({ workspaceRegistry: { list: () => [fakeWorkspace('D:\\fallback', [SID])] } })
  const r = findSessionCwd(ctx, SID, cache)
  check('缓存是空串时继续回退', r.cwd === 'D:\\fallback', String(r.cwd))
}
{
  const ctx = fakeCtx({ workspaceRegistry: { list: () => [fakeWorkspace('', [SID])] } })
  const r = findSessionCwd(ctx, SID, new Map())
  check('registry path 是空串时不算命中', r.cwd === null, String(r.cwd))
}

console.log('\n================================================')
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
console.log('================================================')
if (failed > 0) process.exit(1)
