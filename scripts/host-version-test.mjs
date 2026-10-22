/**
 * 宿主版本检测的测试。
 *
 * 只能验证「不抛错 + 结构正确 + 判定口径」——真实版本取决于运行环境，
 * 所以不断言具体版本号。
 *
 * 运行：node scripts/host-version-test.mjs
 */

import { checkHostVersions, detectHarnessVersion, SUPPORTED_HOST_VERSION } from '../lib/compat.js'

let pass = 0
let fail = 0

function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('[检测结构]')
const detected = detectHarnessVersion()
check('返回 version / packages 两个字段', 'version' in detected && 'packages' in detected)
check('version 是 string 或 null', typeof detected.version === 'string' || detected.version === null)
check('packages 是普通对象', typeof detected.packages === 'object' && detected.packages !== null)
console.log(`        （本机检测结果：${detected.version ?? '拿不到'}）`)

console.log('\n[判定口径]')
const result = checkHostVersions()
check('status 是 ok / mismatch / unknown 之一', ['ok', 'mismatch', 'unknown'].includes(result.status))
check('expected 恒等于 SUPPORTED_HOST_VERSION', result.expected === SUPPORTED_HOST_VERSION)
check(
  'unknown 时 actual 必为 null',
  result.status !== 'unknown' || result.actual === null,
)
check(
  'ok 时 actual 必等于 expected',
  result.status !== 'ok' || result.actual === result.expected,
)
check(
  'mismatch 时 actual 必不等于 expected',
  result.status !== 'mismatch' || result.actual !== result.expected,
)

console.log('\n[不误报]')
// 关键回归：早期实现用 import 解析，会读到 profile 里的陈旧副本
// （0.1.5-rc.3），在健康安装上误报 mismatch。这里断言"要么对、要么不知道"。
check(
  '绝不因为读到陈旧副本而判 mismatch（status 不是 ok 就必须是 unknown）',
  result.status === 'ok' || result.status === 'unknown',
  `status=${result.status} actual=${result.actual}`,
)

console.log(`\n${'='.repeat(48)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
console.log('='.repeat(48))
process.exit(fail === 0 ? 0 : 1)
