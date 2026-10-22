/**
 * 解出 DSH 会话事件日志（`.jsonl.zstd`）的全部内容。
 *
 * DSH 是**分帧追加**写的，`zlib.zstdDecompressSync` 只解第一帧，
 * 所以这里按 zstd 帧魔数（28 B5 2F FD）切分后逐帧解压。
 *
 * 用法：node <本文件> <session.v4.jsonl.zstd> [--errors]
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 找出所有帧起点。 */
function frameStarts(buffer) {
  const starts = []
  let index = buffer.indexOf(MAGIC, 0)
  while (index !== -1) {
    starts.push(index)
    index = buffer.indexOf(MAGIC, index + MAGIC.length)
  }
  return starts
}

const file = process.argv[2]
const onlyErrors = process.argv.includes('--errors')

const buffer = readFileSync(file)
const starts = frameStarts(buffer)
const parts = []
let failed = 0

for (let i = 0; i < starts.length; i += 1) {
  const begin = starts[i]
  const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
  try {
    parts.push(zstdDecompressSync(buffer.subarray(begin, end)).toString('utf8'))
  } catch {
    failed += 1
  }
}

// 魔数也可能出现在压缩数据内部，导致切分错误；逐帧失败时退化为整体解一次。
if (parts.length === 0) {
  try {
    parts.push(zstdDecompressSync(buffer).toString('utf8'))
  } catch (error) {
    console.error('整体解压也失败:', error.message)
    process.exit(1)
  }
}

const lines = parts
  .join('')
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)

console.log(`帧数: ${starts.length}（失败 ${failed}）| 事件行数: ${lines.length}`)

const types = new Map()
const parsed = []
for (const line of lines) {
  try {
    const event = JSON.parse(line)
    types.set(event.type, (types.get(event.type) ?? 0) + 1)
    parsed.push(event)
  } catch {
    parsed.push({ type: '<unparsable>', raw: line.slice(0, 200) })
  }
}

console.log('事件类型:', [...types.entries()].map(([k, v]) => `${k}=${v}`).join(', '))

const suspicious = parsed.filter((event) => {
  const text = JSON.stringify(event)
  return /error|fail|abort|cancel|denied|rejected|retry/i.test(text)
})
console.log('可疑事件数:', suspicious.length)
for (const event of suspicious.slice(0, onlyErrors ? 20 : 6)) {
  console.log('  !', JSON.stringify(event).slice(0, 700))
}

if (!onlyErrors) {
  console.log('\n--- 最后 6 条事件 ---')
  for (const event of parsed.slice(-6)) {
    console.log('  ', JSON.stringify(event).slice(0, 500))
  }
}
