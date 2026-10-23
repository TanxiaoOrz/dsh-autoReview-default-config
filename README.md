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
| ③ | **审查提示词**两档（全局 + 工作区）注入审查请求 | `llm/stream` | 开 |
| — | **设置界面**：五个控件全在「设置 → Auto Review」里 | `settings.section` | — |

三个功能都有独立开关，关掉任何一个不影响另外两个。

### 当前唯一的行为模型

```
工具调用
├─ 文件类工具（read/write/edit）且目标路径在沙箱可写根内 → 静态放行（{kind:'allow'} 短路）
└─ 其它一切（含所有 pwsh 命令）                        → 交给 auto review 的 AI 判断
```

就这两条。**没有正则白名单，也没有静态安全底线**（历史上有过，已删除，原因见下文）。

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

## 功能③：审查提示词（全局 + 工作区）

审查器每审一个工具调用就发一次 LLM 请求。插件在 **`llm/stream`** 拦截这个请求，
把提示词追加进 `PROJECT_INSTRUCTIONS` 段（角色固定为 `constraint`）。

这里的监听器**永远不吞请求**，只做注入；放行判定在功能②。

### 两档作用域

| 档 | 何时生效 | 文件 |
|---|---|---|
| **全局** `global` | 所有会话 | `prompts/global.md` |
| **工作区** `workspace` | 审查请求的 `ENVIRONMENT.cwd` 落在该工作区路径之下 | `prompts/workspace/<目录名>/note.md` + `meta.json` |

**合成顺序：全局在前，工作区在后。** 越具体越靠后（压轴位置权重更高，与
`REVIEW_POLICY` 的 "more specific takes precedence" 一致）。合成后每段带
`[global:global]` / `[workspace:<目录名>]` 标题前缀，便于在日志和审查请求里辨识。

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

## 审查请求的重试

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
node bin/manage.mjs doctor          # 自检数据目录 / 配置 / 两档提示词
node bin/manage.mjs list            # 列出配置、全局提示词、每个工作区档的 name+path
node bin/manage.mjs check-compat    # 验证审查请求识别仍成立（宿主升级后必跑）

node bin/manage.mjs set-global      # 写全局提示词
node bin/manage.mjs set-workspace   # 写工作区提示词（--path / --text [--name]）
node bin/manage.mjs rm-workspace    # 删除工作区档（--name）
```

公共选项 `--home <目录>` 可指定 `DSH_HOME`（缺省读环境变量）。

> **`set-config` 已废弃**：三个开关现在由设置页写进 `cordis.patch.yml`，而 Config
> schema 给每个字段都声明了默认值，会把 `config.json` 里的值遮住。该命令会执行但
> **不生效**，输出里也会警告。改开关请用设置页，或直接编辑
> `profiles/<profile>/cordis.patch.yml` 里 `auto-review-custom` 的 `config` 块。

---

## 数据目录

```
$DSH_HOME/auto-review/
├── probe.log                           # 启动/门禁/Remote 探针（排查"装了但没反应"）
├── decisions.jsonl                     # 静态放行的审计记录
├── config.json                         # 【历史】开关，仅作 Config 未声明时的回落
└── prompts/
    ├── global.md                       # 全局档
    └── workspace/
        └── <叶名>-<哈希>/
            ├── note.md                 # 工作区档提示词
            └── meta.json               # {"path":"<工作区绝对路径>"}
```

任何文件写坏都不会让插件崩溃：`config.json` 解析失败时保留上一版有效值并打 warn；
从未成功加载过则用默认值。

---

## 开发

```bash
node --check client.js lib/index.js      # 语法检查
node scripts/client-structure-test.mjs   # 29 项设置页结构性检查
node scripts/selftest.mjs                # 40 项纯逻辑自测
node scripts/prompt-store-test.mjs       # 40 项提示词文件存储
node scripts/retry-test.mjs              # 38 项重试逻辑
node scripts/host-version-test.mjs       # 9 项宿主版本检测
node scripts/replay-test.mjs             # 冻结 options 重写
node scripts/e2e-sim.mjs                 # 端到端模拟（静态放行/提示词合成/注入）
node scripts/read-session-log.mjs <session.v4.jsonl.zstd>   # 解会话事件日志
```

测试都在**工作区**跑，不启动 DSH。所以 `lib/replay.js` / `lib/prompt-store.js`
刻意不依赖任何 Harness 包（`lib/schema.js` 要 `schemastery`，`lib/typert.js` 要
`zod`，测试不 import 它们）。

### 文件职责

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 插件入口：门禁、三个功能的挂载、Remote 服务 |
| `lib/schema.js` | `Config` schema（5 个 volatile 字段） |
| `lib/rules.js` | 文件类工具的静态放行判定（复刻沙箱语义） |
| `lib/prompts.js` | 提示词合成 + `cwdOfReviewText` |
| `lib/prompt-store.js` | 提示词文件的读写（纯 Node，可测） |
| `lib/replay.js` | 审查请求重发 + 重试（纯 Node，可测） |
| `lib/compat.js` | 审查请求指纹识别 + 提示词注入 |
| `lib/typert.js` | Remote 通道清单（Host `TYPERT` + Client `TYPERT_REMOTE`） |
| `lib/config.js` | `config.json` 回落读取 |
| `lib/manage.js` + `bin/manage.mjs` | CLI |
| `client.js` | 浏览器半区：设置页 |

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
