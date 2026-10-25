# dsh-auto-review-custom

DSH（DeepSeek Harness）的 **Auto review 增强插件**。

> 适配宿主：**`>=0.2.0 <0.3.0`**（已逐点核对 `0.2.0-rc.2` 与 `0.2.1-rc.2`）。
> 落在区间外的版本，升级后**必须先跑** `node bin/manage.mjs check-compat`，
> 再按 [VERSIONS.md §6](./VERSIONS.md#6-设置页与提示词文件通道的升级检查清单f5f11)
> 冒烟一遍设置页。兼容性维护流程见 [VERSIONS.md](./VERSIONS.md)。

---

## 它做什么

| # | 功能 | 注册点 | 默认 |
|---|---|---|---|
| ① | 新会话建好后自动进入 `auto`（Auto review）权限预设 | `session/created` | **关** |
| ② | **文件类工具静态放行**：目标在沙箱可写根内 → 免审直接执行 | `tools/pre-execute` | 开 |
| ③ | **审查提示词**三档（全局 + 工作区 + 会话）注入审查请求 | `llm/stream` | 开 |
| ④ | **拒绝记录**：审查器没放行的调用写进 `denials.jsonl`（含工作区/会话/理由） | `tools/pre-execute` | 开 |
| ⑤ | **AutoReview 管理页签**：右栏里编辑本工作区/本会话提示词 + 看被拒记录 | `sidebar.right.pane.tab` | — |
| — | **设置界面**：五个控件全在「设置 → Auto Review」里 | `settings.section` | — |

各功能都有独立开关，关掉任何一个不影响其它。

### 当前唯一的行为模型

```
工具调用
├─ 文件类工具（read/write/edit）且目标路径在沙箱可写根内 → 静态放行（{kind:'allow'} 短路）
└─ 其它一切（含所有 pwsh 命令）                        → 交给 auto review 的 AI 判断
                                                          ↓
                                                     判决落进 denials.jsonl
```

**没有正则白名单，也没有静态安全底线**（历史上有过，已删除，原因见下文）。

---

## 安装

```bash
# 在 profile 目录里（$DSH_HOME/profiles/web 或 desktop）
dsh plugin --profile web add dsh-auto-review-custom
```

然后确认 `package.json` 的 `dsh.profile.bundles` 里包含 `dsh-auto-review-custom`
（`dsh plugin` 不会自动登记；没有就手动加一行）。重启 `dsh web` 生效。

> **本插件不会在 auto review 不可用时运行**：启动时会检查
> `permissionPresets.names` 是否包含 `auto`，不包含就静默等待
> `permission-presets/catalog-changed` 事件，等不到则不启动。

详细的安装 / 验证 / 回退步骤见 [PUBLISHING.md](./PUBLISHING.md)，
首发执行清单见 [RELEASE-PLAN.md](./RELEASE-PLAN.md)。

### ⚠️ 本地开发 vs GitHub 安装（会互相覆盖）

profile 里那条依赖决定**装哪份代码**。两种写法不能混用：

| 场景 | 依赖写法 | 行为 |
|---|---|---|
| 本地开发 | `file:D:/Program Code/plugins/AutoReviewCustom` | pnpm 装本地工作区的副本；改完源码要 `pnpm install` 或直接覆盖文件 |
| 发布使用 | `github:<owner>/<repo>` | pnpm 按 **lockfile 的 commit** 从 GitHub 拉，**会覆盖本地手改** |

**2026-10-25 踩过**：手工把 0.2.0 文件复制进 `node_modules` 之后，profile 的
一次 `pnpm install` 按 `github:` 声明把整个包重装成远端的 0.1.1，页签连同
0.2.0 的功能一起消失，看起来像"升级后功能消失"。排查线索：
`node_modules/<包>/package.json` 的 version、`node_modules/.modules.yaml` 的修改时间。

**开发期切本地**（用 node 改 JSON，别用 `Set-Content`，它会写 BOM 弄坏 package.json）：

```powershell
cd "$env:DSH_HOME\profiles\web"
node -e "const fs=require('node:fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.dependencies['dsh-auto-review-custom']='file:D:/Program Code/plugins/AutoReviewCustom';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
& 'D:\Program Code\NodeLib\global\node_modules\pnpm\pnpm.exe' install
```

> 本机 `pnpm.ps1` 被执行策略拦死（`running scripts is disabled`），必须用上面的原生 exe。

**开发完成切回 GitHub**：把依赖改回 `github:<owner>/<repo>` 再 `pnpm install`，
并确认 `node_modules/<包>/package.json` 的 version 是你要的那一版（不是旧 commit）。
切换后本地源码改动不再影响运行时。

---

## 仓库里放什么（GitHub 发布）

本仓库**同时是源码仓库和 npm 包的源码**。两者范围不同，别混：

| 范围 | 由谁决定 | 包含 |
|---|---|---|
| **npm 包内容**（`npm pack` / `npm publish`） | `package.json` 的 `files` 白名单 | 18 个文件：`lib/`、`client.js`、`bin/`、`cordis.patch.yml`、`LICENSE`（npm 自动并入）、三份 `.md`、`package.json` |
| **GitHub 仓库内容** | `.gitignore`（黑名单） | 上面全部 **+** `scripts/`（测试）**+** `LICENSE`、`.gitignore`、`.gitattributes`、`RELEASE-PLAN.md` |

也就是说：**`scripts/` 和 `RELEASE-PLAN.md` 故意不进 npm 包**（测试要工作区的
`lib/` 才能跑，对使用者无用），但**应该进 Git 仓库**——别人 clone 下来要能跑测试、
能看懂发布计划。

仓库里**刻意不入库**的只有三类，全部写在 `.gitignore` 里：

| 类别 | 例子 | 为什么不入库 |
|---|---|---|
| 可再生成产物 | `*.tgz`、`node_modules/`、`coverage/` | 每次 `npm pack` 重新生成，入库只会制造冲突 |
| 运行时数据 | `.dsh/`、`probe.log`、`decisions.jsonl`、`*.bak-<时间戳>` | DSH_HOME 缺失时数据根会回落到仓库根；且含本机绝对路径 |
| 凭据与个人环境 | `.env*`、`*.pem`、`*.key`、`.auth.json`、`.vscode/`、`Thumbs.db` | 安全底线，防止误提交 |

首次推到 GitHub 时补两件事：

1. 把 `package.json` 的 `repository` 字段填成你的仓库地址（npm 页面会据此显示源码链接）：
   ```json
   "repository": { "type": "git", "url": "https://github.com/<你的账号>/AutoReviewCustom.git" }
   ```
2. 仓库根目录已带 `LICENSE`（MIT，与 `package.json` 的 `"license": "MIT"` 一致），
   GitHub 会自动识别并在仓库页显示；`npm pack` 也会自动把它并入包里。

别人从 GitHub 直接装（不需要先发 npm）：

```bash
dsh plugin --profile web add "github:<你的账号>/AutoReviewCustom"
```

> 本包**没有构建步骤**，从 git 安装不会触发 pnpm 的构建脚本拦截。
> 装完仍要确认 `dsh.profile.bundles` 里有包名，见 [PUBLISHING.md §1.4](./PUBLISHING.md)。

---

## 设置界面

**设置 → Auto Review**（`settings.section` 槽位，`order: 120`）。

```
Auto Review
─────────────────────────────────────────────
权限
  新会话默认启用 Auto review                 [开关]
  工作区内文件编辑免审                        [开关]

审查提示词
  注入审查提示词                             [开关]
  全局提示词
  ┌───────────────────────────────────┐
  │ 对本项目：pnpm 包管理…              │
  └───────────────────────────────────┘
  [保存]

工作区提示词
  按会话工作目录匹配，多个命中时取路径最长的那个
  ┌───────────────────────────────────┐
  │ 从已注册工作区选择…               ▼ │
  └───────────────────────────────────┘
  ┌──────────────────────┐ ┌──────────┐
  │ D:\work\project      │ │选择目录… │
  └──────────────────────┘ └──────────┘
  ┌───────────────────────────────────┐
  │ 为该工作区追加的提示词              │
  └───────────────────────────────────┘
  [添加]
```

**会话提示词不在这里**——它在会话自己的右栏页签里（功能⑤）。
这样设计是因为会话档的生命周期跟会话绑定：放在设置页里，用户得先知道
会话 id 才能编辑，而那个 id 平时是看不见的。

### 两条数据通道（各用其所）

| 数据 | 通道 | 存在哪 |
|---|---|---|
| 三个开关 | `ctx.configForms` | profile 的 `cordis.patch.yml` |
| 提示词正文 | `ctx.remote.autoReviewPrompts` | `$DSH_HOME/auto-review/prompts/**` |

开关是结构化短值，进 Config 是宿主的正规做法；提示词是长文本，留在文件里才能
直接编辑、能进 git diff。浏览器没有文件系统，所以文件操作走 Host 的 Remote 方法
（typert 通道，见 [开发](#开发)）。

### 工作区路径的三种填法

1. **下拉选择已注册工作区** —— 路径直接来自宿主的 `workspaceRegistry.list()`，
   大小写和拼写必然正确
2. **「选择目录…」** —— 宿主原生目录选择器（`uiWorkspace.pickDirectory()`）
3. **直接手输**

### 全是手写控件

这个构建里**没有**自动表单客户端（官方 `dsh-settings/README.zh.md:39` 亲口承认
「目前没有已发布的客户端这样做」）。宿主只提供表单**数据**，控件全部由插件自己画：
`role="switch"` 开关、`<textarea>`、`<select>`、按钮。样式只用 `--dsw-alias-*`
主题 token，自动跟随明暗主题。

---

## 功能①：新会话默认 auto

**开关位置：设置 → Auto Review →「新会话默认启用 Auto review」。**

改完保存即写入 `cordis.patch.yml`，**不需要重启**（volatile 字段的变更不重挂
插件 fiber，Loader 把新值提交进运行中的引用）。

### 为什么不是"在通用设置里把 auto 选成默认"

宿主不允许。`permissionPresets.catalog()` 返回两份列表：

- `options` —— 可切换的预设（含 `auto`）
- `defaultOptions` —— 设置页渲染用（**只含配置表里的预设，永远不含 `auto`**）

而写设置会走 `defaultSettings()` 校验，非配置预设直接
`throw unknown default preset`。更糟的是，`pinInitialPermission()` 第一件事就是读
这个默认值，一旦写坏 **每个新会话都创建失败**。

所以插件的做法是：**会话建好之后**再切到 auto。用户感知上一致，只是会话日志里
多一条 `permission/preset` 记录。

### 三重护栏（不会覆盖你的选择）

```
defaultPreset === 'auto'     （你打开了开关）
  && !state.seeded           （不是恢复/分叉会话）
  && current === defaultPreset（没被人手动改过）
```

---

## 功能②：文件类工具的静态放行

注册位置：**`tools/pre-execute`**，用 `{ prepend: true }`。

```js
child.on('tools/pre-execute', async (exec, next) => {
  const verdict = await decide({ toolName: exec.name, args: exec.arguments, cwd })
  if (verdict.action === 'allow') return { kind: 'allow' }   // waterfall 到此结束
  return await next()
}, { prepend: true })
```

只处理**根调用**（`exec.agent !== undefined && exec.parent === undefined`），PTC 内层
调用仍归审查器。

### 判定标准 = 复用 DSH 沙箱语义

静态放行**不是**我们另造的一套安全判定，而是直接沿用 DSH 沙箱自己的可写性结论：

```
writableRoots = [会话 cwd, "/tmp", os.tmpdir()]      // 各平台规范化后
```

目标路径解析成绝对路径后，只要落在其中任一根之下（或等于它）就放行。路径包含性
判定复刻了 `@deepseek-ai/dsh-fs-sandbox` 的 `isPathUnder`：先做大小写规范化后的词法
比较（Windows 不敏感），词法不中时再按 `dev + ino` 文件身份逐层上溯比较父目录，
所以软链、8.3 短名、大小写差异都不会误判。

**为什么可以放心放行**：因为沙箱本来就会允许这个写入。我们只是把「沙箱一定会
允许」这个**已经确定的结论**提前用于"要不要审查"，两者不可能冲突——不存在
"我们放行但沙箱拒绝"的情况，也不会出现"我们放行导致越权写入"。沙箱判不可写时我们
不放行（交回 AI 复审），沙箱的最终裁决一点没被改变。

判定过程出任何异常都**保守地不放行**（`catch` 后返回 `review`）。

### 为什么命令类工具（`pwsh` 等）不静态放行

因为**命令的副作用无法静态判定**。`pwsh -Command "..."` 是一段程序，
它的行为取决于变量、函数、管道、当前状态、外部程序的实际实现，不是靠工具名的
参数键能看出来的。任何"看起来只读"的命令都可能通过别名、管道或子表达式产生写
副作用。既然无法静态判定，就不做静态判定——一律交给 AI 审查。

### 为什么删掉了正则白名单和静态安全底线

历史上本插件有过 `rules.json` 正则白名单和 `lib/rules.js` 里的
`HARD_DENY_PATTERNS` 静态底线，**两者都已彻底删除**。原因：

1. **文本匹配永远补不完。** 底线是一份黑名单，写得再长也总有绕过写法。
   实测就漏过 `Remove-Item -Recurse -Force C:\Windows`，加一条还会漏下一条。
2. **底线命中只能"不免审"，挡不住用户手动批准。** 底线拦下的调用仍然会
   弹给用户，用户照样可以点批准——也就是说它并没有真正阻止任何事，
   只是多了一层判断空转（等于空转），却增加了"我们已经守住底线"的虚假安全感。

所以现在的分工是干净的：**能确定性判定的（文件路径）就静态放行，不能确定性判定的
（命令）就完全交给 AI + 用户**，中间不夹一层不可靠的正则。

### 短路跳不过 guard

命中后直接 `return { kind: 'allow' }` 让 waterfall 提前结束，但这**不会绕过工具守卫**。
宿主 `dsh-tools/lib/index.js`：

```js
const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason
```

即无论 waterfall 里是谁返回 allow，`guardReason(exec)` 都会照常执行。详见
[VERSIONS.md §4](./VERSIONS.md)。

---

## 功能③：审查提示词（全局 + 工作区 + 会话）

审查器每审一个工具调用就发一次 LLM 请求。插件在 **`llm/stream`** 拦截这个请求，
把提示词追加进 `PROJECT_INSTRUCTIONS` 段（角色固定为 `constraint`）。

这里的监听器**永远不吞请求**，只做注入；放行判定在功能②。

### 三档作用域

| 档 | 何时生效 | 文件 |
|---|---|---|
| **全局** `global` | 所有会话 | `prompts/global.md` |
| **工作区** `workspace` | 审查请求的 `ENVIRONMENT.cwd` 落在该工作区路径之下 | `prompts/workspace/<目录名>/note.md` + `meta.json` |
| **会话** `session` | 该会话发起的审查请求 | `prompts/session/<会话id>.md` |

**合成顺序：全局 → 工作区 → 会话。** 越具体越靠后（压轴位置权重更高，与
`REVIEW_POLICY` 的 "more specific takes precedence" 一致）。合成后每段带
`[global:global]` / `[workspace:<目录名>]` / `[session:<会话id>]` 标题前缀，
便于在日志和审查请求里辨识。

### ⚠️ 会话档的关键约束（务必理解）

审查请求的 user 文本只有四段（`ENVIRONMENT / PROJECT_INSTRUCTIONS /
FILTERED_HISTORY / PENDING_ACTION`），**`ENVIRONMENT` 里只有 `cwd`，没有会话 id**。

所以会话档不能靠审查请求匹配，只能**旁路绑定**：插件在 `tools/pre-execute`
里拿到 `exec.agent.session.id`，把「当前这个 cwd 上正在被审的是哪个会话」记进
一个**按 cwd 隔离、15 秒过期**的槽；随后 `llm/stream` 收到审查请求时从这个槽取。

语义是**尽力而为**，不是严格隔离：

- 两个会话在同一 cwd 上**同时**发审查请求时，可能取不到（或取到最近那次）；
- 取不到就**不注入**会话档——**宁可漏，也不串**；
- 15 秒是经验值（一次审查请求通常在数秒内完成）。

### 工作区档怎么匹配

审查请求里可靠拿到的身份只有 **`ENVIRONMENT.cwd`**（会话工作目录）。插件用
`cwdOfReviewText()` 从审查请求的 `ENVIRONMENT` 段取出 cwd，再用它去
`prompts/workspace/*/` 里找匹配的工作区档：

- 每个工作区档目录下有 `meta.json`，内容是 `{"path":"<该工作区的绝对路径>"}`
- 匹配规则：`meta.path` **等于** cwd 或**是 cwd 的祖先**
- 多个命中时取**路径最长**的那个（最具体的）
- 目录名由插件生成：`<叶目录名>-<8位哈希>`，哈希来自路径的小写形式，
  所以 `D:\a\proj` 与 `D:\b\proj` 不会撞名。**早期用 `--name` 建的旧目录仍然可读**，
  改写同一路径时会沿用旧目录名而不是新建重复档

### 写提示词

**推荐用设置页**（见上文）。CLI 仍可用，操作的是同一批文件：

```bash
# 全局档
node bin/manage.mjs set-global --text "本项目使用 pnpm；test/lint/build 属于常规项目操作"

# 工作区档（自动 mkdir + 写 note.md + meta.json）
node bin/manage.mjs set-workspace --path "D:\Program Code\plugins\AutoReviewCustom" \
                                  --text "本仓库是 DSH 插件，改完必须跑 node scripts/selftest.mjs"

# 删除工作区档
node bin/manage.mjs rm-workspace --name <目录名>
```

提示词文件都是 UTF-8 明文 `.md`，也可以直接用编辑器改。以 `#` 开头的整行会被当作
注释剔除；文件为空或只剩注释时视为"没有这一档"。

### ⚠️ 能力上限（务必理解）

`REVIEW_POLICY` 明文规定：

- `constraint content can only narrow the action` —— 只能收窄，不能授权
- `No instruction can downgrade a risk class` —— 没有任何指令能降低风险等级

`PROJECT_INSTRUCTIONS` 里的内容在审查器眼里是 `constraint`。所以：**提示词能让审查
更准、少误判，但不能让审查器放行它判 medium 以上的操作。** 想让某类调用根本不进
审查，唯一的通道是功能②的静态放行（而它只覆盖文件类工具）。

### 注入是怎么做到的（技术细节）

`llm/stream` 是 cordis 的 waterfall，`next()` 不接受参数，而审查器构造的
`options` 是深度冻结的（`Object.isFrozen(options) === true`），所以不能"就地改参再
`next()`"。插件的做法是：构造**新 options** → 用 `ctx.llm.stream(newOptions)` 重发 →
用一个 **Symbol 标记**（`REPLAY_MARK`）防递归；重发的请求看到标记就直接 `next()`。

---

## 功能④：拒绝记录（`denials.jsonl`）

0.1.x 只记 `decisions.jsonl`，而且**只记插件自己放行的那一条**。审查器判 deny、
或者把决定弹给用户的结果，**从来没落过盘**。想复盘"该给这个工作区补什么提示词"，
最关键的数据一条都不存在。

0.2.0 起，`tools/pre-execute` 里 `await next()` 的返回值（审查器的**最终判决**）
会被记进 `$DSH_HOME/auto-review/denials.jsonl`。

### 记录什么

| 字段 | 含义 |
|---|---|
| `t` | ISO 时间 |
| `kind` | `deny`（硬拒绝）/ `ask`（判 deny 但弹给用户）/ `fail`（审查器自身失败，fail-closed） |
| `tool` | 工具名 |
| `sessionId` | **会话 id**（回答"哪个会话"） |
| `cwd` | 会话工作目录 |
| `workspace` | 命中的**工作区档目录名**（回答"哪个工作区"）；没配档时为 `null` |
| `reason` | 审查器给的理由原文 |
| `arg` | 参数摘要（`file_path` / `command` 优先，凭据已脱敏） |

### 怎么区分三种 kind

判决形状（`dsh-tools/lib/index.js:3241-3253`）：

| 场景 | kind | 说明 |
|---|---|---|
| 审查跑完、判 deny | `deny` + `info.code = AUTO_REVIEW_DENIED` | 真结论 |
| 审查请求本身跑挂（网络/超时） | `deny`（`failed()` 分支） | 归为 `fail`，不是提示词问题 |
| 判 deny 但弹给用户裁决 | `ask` | 用户后续可能批准 |
| 会话被中止 | `cancel` | 归为 `fail` |

### 查询

```bash
node bin/manage.mjs denials --summary                 # 按工作区/会话/工具/结论排行
node bin/manage.mjs denials --workspace <目录名>       # 某个工作区
node bin/manage.mjs denials --session <会话id>         # 某个会话
node bin/manage.mjs denials --cwd "D:\work"            # 某个目录（含子目录）
node bin/manage.mjs denials --kind fail                # 只看审查器跑挂的
node bin/manage.mjs denials --contains 凭据            # 关键字
```

配套 Skill：**`autoreview-denial-log`**（按提示词复盘的口径解读这些记录）。

### 参数摘要为什么重新实现

0.1.x 的 `audit()` 直接 `JSON.stringify(args).slice(0, 200)`。实测 1086 条里
**653 条正好截在 200 字符**，其中 197 条是 `write`/`edit`——`content` 排在前面
把 `file_path` 挤掉了，记录退化成「某人写了 200 字符」，无法复盘。

`lib/denials.js` 的 `summarizeArgs()` 改成**先抽关键字段再截断**：
`file_path` / `path` / `command` 一定保留。

---

## 功能⑤：AutoReview 管理页签（右栏）

会话标题旁有一个 **「AutoReview 管理」** 按钮，点开在右栏开一个页签。
它解决的是"**就这一次会话**想调口径"——0.1.x 只能改工作区档，那会连带影响
同一工作区的所有会话。

页签里三块：

1. **当前工作区提示词** —— 按本会话 cwd 命中的那个工作区档（最长匹配），
   可直接编辑保存。没有匹配档时明确说明「保存会新建一个」。
2. **当前会话提示词** —— 保存即写 `prompts/session/<会话id>.md`，传空等于删除。
3. **被拒绝的记录** —— 三档 scope 切换：**本会话 / 本工作区 / 全部**，
   新的在前，每行带「追加为提示词」按钮。

> ⚠️ **追加按钮只填草稿、不保存。** 审查理由原文是"为什么拒绝"，不是"允许什么"。
> 直接落盘会把禁止性描述当成授权提示词喂回去，反而误导审查器。必须由人改成
> 正向表述后再点保存。追加的目标框跟随 scope：看本会话记录时进会话档，
> 看本工作区记录时进工作区档——避免"看着 A 却改到 B"。

### 只在 Auto review 预设下出现

这个页签的全部内容只有在审查器真的在跑时才有意义。入口按钮读会话的
`permissions` 投影（`useProjection('permissions')` → `{ currentValue }`），
**不是 `auto` 就不渲染**。

- 投影还没到达（`undefined`）时**按可见处理**——会话刚建好时可能短暂没有该帧，
  此时隐藏会让按钮闪一下。
- 页签内部也做同一道门禁：非 `auto` 时禁用编辑并说明原因，而不是让人对着灰框猜。

### 技术要点

- 两阶段注册（`ui-sidebar-right` 的扩展点）：
  `sidebarRightTabs.register({ id, kind, priority:'extension', guide })` 声明类型，
  `slots.register('sidebar.right.pane.tab', { key: id })` 提供正文，
  `slots.register('sidebar.right.pane.tab.title', { key: id })` 提供 chip 标题。
- ⚠️ **页签注册必须放在独立子插件里**（`ctx.plugin({ inject: ['slots','sidebarRightTabs','sidebarRight'], apply })`），
  **不能**把 `sidebarRightTabs` / `sidebarRight` 写进本插件的**顶层** `inject`。
  原因：cordis 的注入是**强制**语义——顶层 `inject` 里列了缺失的服务，整个插件
  fiber 直接判 INACTIVE，`apply` 一行不跑。右栏只在部分构建里存在，写进顶层会让
  **设置页跟着一起消失**。实测复现：
  ```
  inject:['slots']                        + slots 存在        → 应用了
  inject:['slots','sidebarRightTabs']     + 后者缺失          → 未应用（整插件不跑）
  ```
  拆成子插件后：无右栏 → `[父插件应用]`；有右栏 → `[父插件应用, 子插件应用]`，
  设置页始终可用。`scripts/client-structure-test.mjs` 的「注入隔离」分组
  锁死了这条，防止回归。
- 页签是 `scope: 'session'` 槽位，`sessionId` 与 `useProjection` 由框架注入。
- **cwd 必须走缓存**（这是 0.2.0 的一个实机 bug，已修）：`SessionSnapshot` 不含
  cwd，而 `ctx.agents.get(id)` 拿到的 `Agent` **类型上只有 `{ id }`**、没有
  `.session`（Host `Service.listService('agents')` 的 referencedTypes 可查），
  所以 `agent.session.header.cwd` 恒为 undefined → 页签「目录: —」、工作区输入框
  全灰、无法保存。
  修法：在 **`tools/pre-execute`** 里把 `exec.agent.session.header.cwd`
  （这个**一直是准的**）写进 `sessionId → cwd` 缓存，`readSessionContext` 先查缓存。
  反查顺序见 `lib/session-cwd.js`：**缓存 → `workspaceRegistry` 的 `sessionIds` 归属
  → `agents` 探测**，每层结果记进 `probe.log`（`cwd-miss … via=… registry=… agents=…`）。
  缓存未命中时页签还提供「从已注册工作区选择…」兜底，不会死锁。
- 会话页签与设置页**共用同一个 Remote 挂载单例**（`mountPromptRemote`），
  不会重复 `$mount`。

---

宿主自带的重试挂在 `agent/request-error` 上，**只有 agent loop 会派发**；
而审查器走的是裸 `ctx.llm.stream()`，完全绕过那条路。结果：同一类瞬时传输错误，
主对话会被静默重试最多 5 次，审查请求却第一次失败就直接 fail-closed。

既然 `TRANSPORT / TIMEOUT / SERVER` 本来就在宿主的默认可重试码列表里，插件补了一次
等价重试（`lib/replay.js`）：

```
最多 3 次尝试，间隔 500ms → 1000ms
只重试 finish.reason.kind === 'error' 且 code 在可重试集合内的失败
调用方抛出的异常立即上抛，不重试
signal 中止时立刻停止等待
```

实现要点：**流式输出必须缓冲**。第一次尝试如果已经吐了 chunk，重试就不能再吐一遍，
否则前端会收到重复内容。所以 `replayStream` 会先把 chunk 收齐，确认这一轮成功
之后才向外 yield。

---

## 命令速查

```bash
node bin/manage.mjs doctor          # 自检数据目录 / 配置 / 三档提示词 / 拒绝记录
node bin/manage.mjs list            # 列出配置、全局档、工作区档、会话档、拒绝记录条数
node bin/manage.mjs check-compat    # 验证审查请求识别仍成立（宿主升级后必跑）

node bin/manage.mjs set-global      # 写全局提示词
node bin/manage.mjs set-workspace   # 写工作区提示词（--path / --text [--name]）
node bin/manage.mjs rm-workspace    # 删除工作区档（--name）

node bin/manage.mjs set-session     # 写会话档（--session <id> --text "..."）
node bin/manage.mjs rm-session      # 删除会话档（--session <id>）
node bin/manage.mjs list-sessions   # 列出所有会话档

node bin/manage.mjs denials         # 查拒绝记录（--summary / --workspace / --session / --cwd / --kind / --contains / --since / --limit）
```

公共选项 `--home <目录>` 可指定 `DSH_HOME`（缺省读环境变量）。

> **`set-config` 已废弃**：三个开关现在由设置页写进 `cordis.patch.yml`，而 Config
> schema 给每个字段都声明了默认值，会把 `config.json` 里的值遮住。该命令会执行但
> **不生效**，输出里也会警告。改开关请用设置页，或直接编辑
> `profiles/<profile>/cordis.patch.yml` 里 `auto-review-custom` 的 `config` 块。

### 配套 Skill

| Skill | 干什么 |
|---|---|
| `autoreview-denial-log` | 读 `denials.jsonl`，按工作区/会话/工具统计，判断该补哪条提示词 |
| `autoreview-prompt-append` | 选对作用域（全局/工作区/会话）并把判断写成合格的 constraint |

---

## 数据目录

```
$DSH_HOME/auto-review/
├── probe.log                           # 启动/门禁/Remote 探针（排查"装了但没反应"）
├── decisions.jsonl                     # 插件**自己放行**的审计记录（ruleId + action=allow）
├── denials.jsonl                       # 审查器**没放行**的记录（0.2.0 新增：kind + reason + 会话/工作区）
├── config.json                         # 【历史】开关，仅作 Config 未声明时的回落
└── prompts/
    ├── global.md                       # 全局档
    ├── workspace/
    │   └── <叶名>-<哈希>/
    │       ├── note.md                 # 工作区档提示词
    │       └── meta.json               # {"path":"<工作区绝对路径>"}
    └── session/
        └── <会话id>.md                  # 会话档提示词（0.2.0 新增）
```

两个 jsonl 分工明确，**互不替代**：

| 文件 | 记的是 | 有 `reason` |
|---|---|---|
| `decisions.jsonl` | 插件自己做的静态放行（`ruleId` + `action: allow`） | ❌ |
| `denials.jsonl` | 审查器的结论（`deny` / `ask` / `fail`） | ✅ |

任何文件写坏都不会让插件崩溃：`config.json` 解析失败时保留上一版有效值并打 warn；
从未成功加载过则用默认值。`denials.jsonl` 的坏行在读取时跳过，不影响其余记录。

---

## 开发

```bash
node --check client.js lib/index.js      # 语法检查
node scripts/client-structure-test.mjs   # 73 项设置页 + 页签结构性检查
node scripts/selftest.mjs                # 40 项纯逻辑自测
node scripts/prompt-store-test.mjs       # 40 项提示词文件存储
node scripts/denial-session-test.mjs     # 54 项拒绝记录 + 会话档 + 绑定槽（0.2.0）
node scripts/session-cwd-test.mjs        # 25 项会话→cwd 三层反查（含 Agent 无 session 的实机形态）
node scripts/retry-test.mjs              # 38 项重试逻辑
node scripts/host-version-test.mjs       # 9 项宿主版本检测
node scripts/replay-test.mjs             # 冻结 options 重写
node scripts/e2e-sim.mjs                 # 端到端模拟（静态放行/提示词合成/注入）
node scripts/read-session-log.mjs <session.v4.jsonl.zstd>   # 解会话事件日志
```

测试都在**工作区**跑，不启动 DSH。所以 `lib/replay.js` / `lib/prompt-store.js` /
`lib/session-prompts.js` / `lib/denials.js` 刻意不依赖任何 Harness 包
（`lib/schema.js` 要 `schemastery`，`lib/typert.js` 要 `zod`，测试不 import 它们）。

### 文件职责

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 插件入口：门禁、各功能的挂载、Remote 服务 |
| `lib/schema.js` | `Config` schema（5 个 volatile 字段） |
| `lib/rules.js` | 文件类工具的静态放行判定（复刻沙箱语义） |
| `lib/prompts.js` | 三档提示词合成 + `cwdOfReviewText` + `findWorkspaceId` |
| `lib/prompt-store.js` | 提示词文件的读写（纯 Node，可测） |
| `lib/session-prompts.js` | **会话档存储 + 会话↔cwd 绑定槽**（0.2.0，纯 Node，可测） |
| `lib/denials.js` | **拒绝记录写入与查询 + 参数摘要 + 脱敏**（0.2.0，纯 Node，可测） |
| `lib/replay.js` | 审查请求重发 + 重试（纯 Node，可测） |
| `lib/compat.js` | 审查请求指纹识别 + 提示词注入 |
| `lib/typert.js` | Remote 通道清单（Host `TYPERT` + Client `TYPERT_REMOTE`） |
| `lib/config.js` | `config.json` 回落读取 |
| `lib/manage.js` + `bin/manage.mjs` | CLI |
| `client.js` | 浏览器半区：设置页 + **会话页签** |

### 三个必须知道的坑

**1. `apply` 里绝不能 `await $mount`**

`dsh-api-gateway` 的 `$mount` 把挂载塞进一条**全局串行的 mutation 队列**
（`enqueue`，`lib/client.js:1657`）。客户端启动时 `dsh-api-remotes` 要挂约 25 个
内置命名空间（`sessions`、`modelSelection` 等），走的是同一条队列。在 `apply`
阶段挂载会**插进启动序列**：一旦这次挂载异常或停顿，排在它后面的内置命名空间就
装不上——表现是「新会话能打开、消息发不出去」。

所以客户端的 `apply` **保持同步**，一个挂载动作都不做；等用户真正打开设置页时
才惰性挂载（那时队列已空）。

**2. Remote 返回值是信封**

网关**总是**返回 `{ ok: true, value }` 或 `{ ok: false, error }`。不拆包就永远读到
`undefined`——页面会显示"有内容但输入框是空的"。见 `client.js` 的 `unwrapRemote()`。

**3. 服务对象必须有 `typertRemote` 绑定**

Gateway 在**每次派发**时都校验它（`dsh-api-gateway/lib/index.js:1450-1462`）：

```js
const value = Reflect.get(original, 'typertRemote')
if (value === undefined) throw 'gateway/binding-invalid'
value.service === original && value.serviceKey === key
```

官方写法是继承 `TypertRemoteService`；插件手写等价绑定（见 `lib/index.js`
`mountPromptRemote`），省掉对 `@deepseek-ai/dsh-typert-protocol` 的静态 import——
少一个「包缺失就整插件加载失败」的风险。

另外：参数的 codec **必须** `mode: 'strict'`（`src-json` 只能用在 result 上），
否则 `$mount` 会报 `field "x" has no strict codec`。

---

## 已知限制

### 审查器调用失败 = 工具调用被静默拒绝

这是**宿主行为**，不是本插件引入的，但你必须知道，否则会误判成插件 bug。

审查要发一次真实的 LLM 请求。这次请求失败时（网络抖动、官方 API 传输错误、超时等），
`auto-review` 走的是 `failed()` 分支：

```js
// dsh-experimental-auto-review/lib/index.js:478
if (!review.ok) return failed(exec, review.error)   // → { kind: 'deny' }
```

`failed()` 返回**硬拒绝**，**不经过 `askUser()`**，所以：

| 情况 | 结果 |
|---|---|
| 审查跑完、判 deny | **弹窗**，你可以批准 |
| **审查跑挂**（API 失败/超时） | **静默拒绝，无任何弹窗** |

**这是有意的 fail-closed 设计**：如果审查器坏了就改成问用户，那么让审查 API 失效
（断网、打满配额、塞爆上下文）就能绕过审查。宁可拒绝，也不 fail open。

插件为此补了重试（见上文），但不能消除这个语义。

> 另注：审查用的模型**跟随会话当前模型**（`session.requestHeader()`），
> 不是固定模型。所以换模型会连带改变审查的质量、成本和稳定性。

### 宿主版本兼容性

| 项 | 值 |
|---|---|
| 兼容区间 | **`>=0.2.0 <0.3.0`**（同一 minor 内的补丁/预发布版本都接受） |
| 逐点核对过 | `0.2.0-rc.2`（本机实测）、`0.2.1-rc.2`（下载厂商包逐条核对 F1–F11） |
| 判定方式 | 只比 `major.minor`，不看 `-rc.N` 标签——标签变化不影响内部事实表 |

插件启动时会读取**当前进程实际运行的那套 DSH** 的版本（从 `process.argv[1]` 上溯到
安装目录，读 `@deepseek-ai/dsh/package.json`），与上面的区间比对。

**落在区间外**才 `warn` 一条明确的提示，并在 `probe.log` 写
`host-versions: MISMATCH actual=… expected=…`。这样别人装到别的版本上时能**当场看到**，
而不是遇到「装了个没用的东西」还找不到原因。

> **为什么不写死成单个精确版本**：0.1.x 曾只认 `0.2.0-rc.2`，宿主发 `0.2.1-rc.2` 后
> 即使 F1–F11 逐条都没变也会误报 MISMATCH，用户看到「版本不匹配」就以为插件坏了。
> 现在改成区间 + 一份 `VERIFIED_HOST_VERSIONS` 逐点核对清单（见 `lib/compat.js`）。

> **不会误报**：判定只认 `@deepseek-ai/dsh` 这一个包，且**拿不到版本就静默跳过**
> （返回 `unknown` 不告警）。故意不从 `import('@deepseek-ai/...')` 读版本——那会读到
> `profiles/<profile>/node_modules/` 里的**陈旧副本**，在健康安装上误报。

### 其他

- 提示词只能收窄判断，不能授权（见功能③）
- 命令类工具永远需要 AI 审查，没有"免审白名单"可用（见功能②）
- `run_code`（PTC）外层被 auto-review 有意跳过；静态放行也只处理根调用
- `tools/pre-execute` / `llm/stream` / 审查请求格式若被宿主改版，功能会静默失效 →
  用 `check-compat` 提前发现，或用上面的运行时版本告警提前察觉
- 工作区档靠 `ENVIRONMENT.cwd` 做祖先/相等匹配：cwd 拿不到时只注入全局档
- 设置页的 `config` 块被写进 `cordis.patch.yml` 时，`name` 会被 config-editor
  解析成**绝对 file:// URL**。改它会让编辑器认不出此行而重复添加，**不要手动改**
