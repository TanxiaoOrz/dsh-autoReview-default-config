/**
 * 设置页客户端的结构性检查（不启动浏览器）。
 *
 * 运行：node scripts/client-structure-test.mjs
 */

import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

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

function heading(text) {
  console.log(`\n[${text}]`)
}

heading('加载契约')
check('使用模块加载器', src.includes('__ModuleLoader__.load'))
check('模块 id 等于包名', src.includes("id: 'dsh-auto-review-custom'"))
check('apply 保持同步（不在启动阶段挂载）', !src.includes('async apply(ctx)'))
check('不再在 apply 里 await', !/apply\(ctx\)\s*\{[^}]{0,600}\bawait\b/.test(src.split('apply(ctx)')[1]?.slice(0, 600) ?? ''))

heading('Remote 通道')
check('惰性挂载函数存在', src.includes('function mountPromptRemote(ctx)'))
check('挂载单例（只挂一次）', src.includes('let promptMount = null') && src.includes('if (promptMount !== null) return promptMount'))
check('解包返回信封', src.includes('function unwrapRemote'))
check('read 使用解包', src.includes('unwrapRemote(envelope)'))
check('失败可读化', src.includes('function describeRemoteFailure'))

heading('目录选择器')
check('接入了 uiWorkspace', src.includes("ctx.get?.('uiWorkspace')"))
check('调用 pickDirectory', src.includes('workspace.pickDirectory()'))
check('有选择按钮文案', src.includes('选择目录') && src.includes('Browse'))
check('不可用时有说明', src.includes('browseUnavailable'))

heading('工作区路径的三种填法')
check('客户端描述符 5 条', (src.match(/descriptor\('/g) ?? []).length === 5)
check('含 listWorkspaces 描述符', src.includes("descriptor('listWorkspaces', [])"))
check('调用 listWorkspaces', src.includes('promptApi.listWorkspaces()'))
check('下拉 select 存在', src.includes("'select',"))
check('下拉文案中英齐全', src.includes('从已注册工作区选择') && src.includes('Pick a registered workspace'))
check('仍保留浏览按钮', src.includes('onClick: browse'))
check('仍保留手输框', src.includes("placeholder: t('workspacePathPlaceholder')"))

heading('保存反馈')
check('横幅组件样式存在', src.includes('.arc-banner'))
// 注意：`sectionPermission` 在文案字典里也会出现，所以要用渲染期才有的写法定位。
const bannerAt = src.indexOf("className: 'arc-banner'")
const permissionAt = src.indexOf("t('sectionPermission')")
check(
  '横幅渲染在权限段之前',
  bannerAt !== -1 && permissionAt !== -1 && bannerAt < permissionAt,
  `banner=${bannerAt} permission=${permissionAt}`,
)
check('横幅有 role=status', src.includes("role: 'status'"))
check('用 seq 强制重新计时', src.includes('seqRef.current += 1') && src.includes('key: notice.seq'))
check('不再按内容相等禁用保存', !src.includes('globalDraft === storedGlobal,') && !src.includes('draft === entry.prompt,'))
check('显示 3.5 秒', src.includes('3500'))

heading('样式约束')
check('无硬编码颜色', !/#[0-9a-f]{3,8}\b/i.test(src))
check('只用主题 token', src.includes('--dsw-alias-'))
check('中英文案齐全', src.includes('已保存') && src.includes('Prompt saved'))

console.log(`\n${'='.repeat(48)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
console.log('='.repeat(48))
process.exit(fail === 0 ? 0 : 1)
