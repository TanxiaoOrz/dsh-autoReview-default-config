/**
 * 提示词文件存储的测试（纯 Node，不启动 DSH）。
 *
 * 运行：node scripts/prompt-store-test.mjs
 */

import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GLOBAL_PROMPT_FILE,
  WORKSPACE_META_FILE,
  WORKSPACE_PROMPT_FILE,
  findWorkspaceDirName,
  listWorkspacePrompts,
  readAllPrompts,
  readGlobalPrompt,
  removeWorkspacePrompt,
  workspaceDirName,
  writeGlobalPrompt,
  writeWorkspacePrompt,
} from '../lib/prompt-store.js'

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

const root = mkdtempSync(join(tmpdir(), 'arc-ps-'))

// ── 1. 全局提示词 ────────────────────────────────────────────────────────
heading('全局提示词')
{
  check('初始为空', readGlobalPrompt(root) === '')
  writeGlobalPrompt(root, '第一版全局提示词')
  check('写入后可读', readGlobalPrompt(root) === '第一版全局提示词')
  check('文件真实存在', existsSync(join(root, 'prompts', GLOBAL_PROMPT_FILE)))
  writeGlobalPrompt(root, '第二版')
  check('覆盖生效', readGlobalPrompt(root) === '第二版')
  writeGlobalPrompt(root, '')
  check('写空串等于删除', !existsSync(join(root, 'prompts', GLOBAL_PROMPT_FILE)))
  check('删除后读回空串', readGlobalPrompt(root) === '')
}

// ── 2. 工作区档：新建 / 读取 ─────────────────────────────────────────────
heading('工作区档')
{
  const name = writeWorkspacePrompt(root, 'D:\\work\\alpha', 'alpha 的提示词')
  check('目录名含可读叶名', name.startsWith('alpha-'), name)
  check('目录名含哈希', /-[0-9a-f]{8}$/.test(name), name)

  const listed = listWorkspacePrompts(root)
  check('列表有 1 条', listed.length === 1, JSON.stringify(listed))
  check('路径正确', listed[0]?.path === 'D:\\work\\alpha', listed[0]?.path)
  check('提示词正确', listed[0]?.prompt === 'alpha 的提示词')

  const dir = join(root, 'prompts', 'workspace', name)
  check('meta.json 存在', existsSync(join(dir, WORKSPACE_META_FILE)))
  check('note.md 存在', existsSync(join(dir, WORKSPACE_PROMPT_FILE)))

  const meta = JSON.parse(readFileSync(join(dir, WORKSPACE_META_FILE), 'utf8'))
  check('meta.json 记录绝对路径', meta.path === 'D:\\work\\alpha', JSON.stringify(meta))
}

// ── 3. 同路径重复写：不能产生第二个目录 ──────────────────────────────────
heading('同路径重复写不重复建档')
{
  const before = listWorkspacePrompts(root).length
  const name2 = writeWorkspacePrompt(root, 'D:\\work\\alpha', 'alpha 第二版')
  const after = listWorkspacePrompts(root)
  check('目录数不变', after.length === before, `${before} -> ${after.length}`)
  check('内容已更新', after[0]?.prompt === 'alpha 第二版', after[0]?.prompt)
  check('返回的是原来的目录名', name2 === after[0]?.name, name2)
}

// ── 4. 大小写/斜杠归一后仍视为同一路径 ───────────────────────────────────
heading('路径归一')
{
  const before = listWorkspacePrompts(root).length
  writeWorkspacePrompt(root, 'd:/work/alpha', '改大小写')
  check('Windows 下大小写不产生新档', listWorkspacePrompts(root).length === before)
}

// ── 5. 多个工作区排序 ────────────────────────────────────────────────────
heading('多档排序')
{
  writeWorkspacePrompt(root, 'D:\\work\\beta', 'beta 提示词')
  const listed = listWorkspacePrompts(root)
  check('两条', listed.length === 2, JSON.stringify(listed.map((x) => x.path)))
  check(
    '按路径排序',
    listed[0].path.localeCompare(listed[1].path) < 0,
    JSON.stringify(listed.map((x) => x.path)),
  )
  check(
    '保留首次写入的路径拼写（不被大小写覆盖）',
    listed.some((x) => x.path === 'D:\\work\\alpha'),
    JSON.stringify(listed.map((x) => x.path)),
  )
}

// ── 6. 删除 ──────────────────────────────────────────────────────────────
heading('删除')
{
  const target = listWorkspacePrompts(root).find((x) => x.path === 'D:\\work\\beta')
  check('先找到 beta', target !== undefined)
  check('删除成功', removeWorkspacePrompt(root, target.name) === true)
  check('删除后只剩 1 条', listWorkspacePrompts(root).length === 1)
  check('重复删除返回 false', removeWorkspacePrompt(root, target.name) === false)
}

// ── 7. 目录穿越防御 ──────────────────────────────────────────────────────
heading('安全：目录穿越')
{
  for (const bad of ['..', '.', '', 'a/b', 'a\\b', '../etc']) {
    check(`拒绝 ${JSON.stringify(bad)}`, removeWorkspacePrompt(root, bad) === false)
  }
}

// ── 8. 兼容旧命名（CLI 用 --name 建的档）─────────────────────────────────
heading('兼容旧命名档')
{
  const legacyDir = join(root, 'prompts', 'workspace', 'autoreview-project')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, WORKSPACE_META_FILE), JSON.stringify({ path: 'D:\\legacy\\proj' }), 'utf8')
  writeFileSync(join(legacyDir, WORKSPACE_PROMPT_FILE), '旧档提示词\n', 'utf8')

  const listed = listWorkspacePrompts(root)
  check('能读到旧命名档', listed.some((x) => x.name === 'autoreview-project'), JSON.stringify(listed.map((x) => x.name)))
  check('旧档路径正确', findWorkspaceDirName(root, 'D:\\legacy\\proj') === 'autoreview-project')

  // 改写同一路径必须沿用旧目录名，不能新建
  const before = listWorkspacePrompts(root).length
  const name = writeWorkspacePrompt(root, 'D:\\legacy\\proj', '更新后的旧档')
  check('沿用旧目录名', name === 'autoreview-project', name)
  check('目录数不变', listWorkspacePrompts(root).length === before)
  check(
    '内容已更新',
    listWorkspacePrompts(root).find((x) => x.name === 'autoreview-project')?.prompt === '更新后的旧档',
  )
}

// ── 9. readAllPrompts 汇总 ───────────────────────────────────────────────
heading('readAllPrompts')
{
  writeGlobalPrompt(root, '汇总测试全局')
  const all = readAllPrompts(root)
  check('含 global', all.global === '汇总测试全局')
  check('含 workspaces 数组', Array.isArray(all.workspaces) && all.workspaces.length > 0)
}

// ── 10. workspaceDirName 稳定性 ──────────────────────────────────────────
heading('workspaceDirName')
{
  const a = workspaceDirName('D:\\work\\alpha')
  const b = workspaceDirName('d:\\work\\alpha')
  check('同路径大小写不同但哈希一致', a === b, `${a} vs ${b}`)
  check('不同路径不同名', workspaceDirName('D:\\work\\alpha') !== workspaceDirName('D:\\work\\beta'))
}

rmSync(root, { recursive: true, force: true })

console.log(`\n${'='.repeat(48)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
console.log('='.repeat(48))
process.exit(fail === 0 ? 0 : 1)
