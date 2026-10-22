#!/usr/bin/env node
/**
 * CLI 入口：`node bin/manage.mjs <命令> [选项]`
 *
 * 只做 argv 转发与退出码映射，逻辑全在 lib/manage.js（便于单测复用 run()）。
 */

import { run } from '../lib/manage.js'

const { code, output } = run(process.argv.slice(2))
if (output.length > 0) {
  if (code === 0) console.log(output)
  else console.error(output)
}
process.exit(code)
