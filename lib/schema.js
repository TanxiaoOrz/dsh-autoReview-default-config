/**
 * 插件的 Config schema —— 它**就是**设置页的数据源。
 *
 * ## 为什么所有字段都必须 `.volatile()`
 *
 * 宿主 `dsh-settings` 的表单投影只收 volatile 字段：
 *
 * - `dsh-settings/lib/index.js:417-419` —— 一个 volatile 字段都没有的条目会被
 *   `describe()` **整条丢弃**；
 * - `:153-158`、`:507`、`:513-523` —— 写入路径逐字段校验 `isVolatilePath`，
 *   非 volatile 直接抛 `Config field ... is not volatile`。
 *
 * 而且 volatile 字段的变更**不会重挂插件 fiber**（`cordis-plugin-loader/lib/index.js:380-425`）：
 * Loader 把新值提交进正在运行的引用并 emit `loader/volatile-update`。
 * 所以读取必须走 `config.field.get()`，并在 `loader/volatile-update` 时重新计算。
 *
 * ## 存储位置
 *
 * 值写进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 的 `- id: auto-review-custom`
 * 条目的 `config:` 块。用户手改 patch 与 UI 写入不会静默互相覆盖：
 * revision 栅栏会抛 `SETTINGS_CONFLICT`，被 home patch 盖住时会被直接拒绝。
 *
 * @module dsh-auto-review-custom/schema
 */

import z from '@deepseek-ai/schemastery'

/**
 * 插件配置。
 *
 * 字段顺序即设置页的展示顺序（客户端按这个顺序画控件）。
 */
export const Config = z.object({
  /** 新会话建好后是否自动切到 auto 预设。 */
  defaultPreset: z
    .union(['auto', 'off'])
    .default('off')
    .description('新会话创建后自动切换到 Auto review 预设')
    .volatile(),

  /** 是否把提示词注入审查请求的 PROJECT_INSTRUCTIONS 段。 */
  prompts: z
    .boolean()
    .default(true)
    .description('把提示词注入审查请求，让审查模型读到你的判断口径')
    .volatile(),

  /** 是否对文件类工具做静态放行（目标须在沙箱可写根内）。 */
  allowRules: z
    .boolean()
    .default(true)
    .description('工作区内的 read/write/edit 免审直接执行（复用 DSH 沙箱语义）')
    .volatile(),

  /**
   * 全局审查提示词。
   *
   * 空字符串 = 不追加任何内容（宿主那串 `REVIEW_POLICY` 英文常量始终在，
   * 我们从来不改它，只是往 `PROJECT_INSTRUCTIONS` 段追加一条 constraint）。
   */
  globalPrompt: z
    .string()
    .default('')
    .description('对所有会话生效的审查提示词；留空 = 不追加')
    .volatile(),

  /**
   * 工作区提示词：`工作区绝对路径 → 提示词`。
   *
   * 匹配规则与会话的工作目录一致：值是某个 cwd 的祖先或相等即命中，
   * 多个命中时取路径最长的（最具体的那个）。
   */
  workspacePrompts: z
    .dict(z.string())
    .default({})
    .description('按工作区路径追加的审查提示词')
    .volatile(),
})
