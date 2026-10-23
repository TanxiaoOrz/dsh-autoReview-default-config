/**
 * 宿主版本检测的测试。
 *
 * 只能验证「不抛错 + 结构正确 + 判定口径」——真实版本取决于运行环境，
 * 所以不断言具体版本号。
 *
 * 运行：node scripts/host-version-test.mjs
 */

import {
  checkHostVersions,
  detectHarnessVersion,
  isSupportedHostVersion,
  SUPPORTED_HOST_RANGE,
  SUPPORTED_HOST_VERSION,
  VERIFIED_HOST_VERSIONS,
} from '../lib/compat.js'

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

console.log('\n[判定口径：区间而非精确]')
const result = checkHostVersions()
check('status 是 ok / mismatch / unknown 之一', ['ok', 'mismatch', 'unknown'].includes(result.status))
check('expected 恒等于 SUPPORTED_HOST_VERSION', result.expected === SUPPORTED_HOST_VERSION)
check('返回 verified 标志', typeof result.verified === 'boolean')
check('unknown 时 actual 必为 null', result.status !== 'unknown' || result.actual === null)
check(
  'ok 时 actual 必落在适配区间内',
  result.status !== 'ok' || isSupportedHostVersion(result.actual),
)
check(
  'mismatch 时 actual 必不在适配区间内',
  result.status !== 'mismatch' || !isSupportedHostVersion(result.actual),
)
check(
  'verified 只在逐点核对过时为真',
  result.verified === VERIFIED_HOST_VERSIONS.includes(result.actual),
)

console.log('\n[区间判定本身]')
// 用户明确要求覆盖 0.2.0 与 0.2.1-rc.2 两端。
check('0.2.0-rc.2 判为兼容', isSupportedHostVersion('0.2.0-rc.2'))
check('0.2.1-rc.2 判为兼容', isSupportedHostVersion('0.2.1-rc.2'))
check('0.2.0 正式版判为兼容', isSupportedHostVersion('0.2.0'))
check('0.2.5 判为兼容（同 minor）', isSupportedHostVersion('0.2.5'))
check('0.3.0 判为不兼容（换 minor）', !isSupportedHostVersion('0.3.0'))
check('0.1.5-rc.3 判为不兼容（旧 minor）', !isSupportedHostVersion('0.1.5-rc.3'))
check('解析不出的版本判为不兼容', !isSupportedHostVersion('not-a-version'))
check(
  '两个已核对版本都在区间内',
  VERIFIED_HOST_VERSIONS.every((version) => isSupportedHostVersion(version)),
)
check(
  '区间常量与 expected 自洽',
  SUPPORTED_HOST_VERSION ===
    `>=${SUPPORTED_HOST_RANGE.major}.${SUPPORTED_HOST_RANGE.minor}.0 ` +
      `<${SUPPORTED_HOST_RANGE.major}.${SUPPORTED_HOST_RANGE.minor + 1}.0`,
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
