# 版本适配声明

> 本文件是**插件与宿主兼容性**的唯一权威记录。
> 宿主（DSH / `@deepseek-ai/*`）任何一次升级，都必须按本文流程复验；
> 不兼容则发新版插件，并在下表追加一行。
>
> **当前兼容区间：`>=0.2.0 <0.3.0`**（已逐点核对 `0.2.0-rc.2`、`0.2.1-rc.2`）。
> ⚠️ 下表「出处」列的行号是 **0.2.0-rc.2** 时的快照。0.2.1-rc.2 已把
> `dsh-api-gateway` 的 `lib/client.js` 拆成 `client.browser.js` / `client.node.js`，
> **行号会漂移**——检索时请按「文件名 + 符号名」（如 `validateBinding`），别按旧行号。

---

## 1. 为什么需要这份文件

本插件的四个能力，全部建立在**宿主的内部实现细节**上，而不是公开契约：

| # | 我们依赖的内部事实 | 出处（0.2.0-rc.2） | 一旦改动会怎样 |
|---|---|---|---|
| F1 | 审查器的 system prompt 以 `REVIEW_POLICY\nYou are the final authorization reviewer` 开头 | `dsh-experimental-auto-review/lib/index.js:20-41` | **认不出审查请求** → 功能③静默失效 |
| F2 | 审查请求的 user 文本由 `ENVIRONMENT / PROJECT_INSTRUCTIONS / FILTERED_HISTORY / PENDING_ACTION` 四段拼成 | 同上 `:322-333` | **提示词注不进去** → 功能③失效；`ENVIRONMENT.cwd` 取不到 → 工作区档不匹配 |
| F3 | `readDecision()` 只接受「零或多个 reasoning 块 + 恰好一个 text 块 + 终止 `finish(stop)`」，且 finish 后不得再有 chunk | 同上 `:377-397` | 功能③的重发流若被改坏会被判协议违规 |
| F4 | `permissionPresets` 的 `auto` 是保留名：不在 `presets` 表、不许成为默认值、只在 integration 存活期间出现在 `names` 里 | `dsh-permission-presets/lib/index.js:52,176,238-240,313-317` | 功能①失效或报错 |

### 1.1 设置页与提示词文件通道的依赖（F5–F11）

这一组是**2026-10-18 实测确认**的，属于「改版就静默失效、而且极难定位」的类型：
症状是「界面看着正常，但某个操作没反应」，不崩溃、不报错。

| # | 我们依赖的内部事实 | 出处（0.2.0-rc.2） | 一旦改动会怎样 |
|---|---|---|---|
| **F5** | `$mount` 把挂载动作塞进一条**全局串行的 mutation 队列**；客户端启动时 `dsh-api-remotes` 挂约 25 个内置命名空间走的是同一条队列 | `dsh-api-gateway/lib/client.js:1636-1646`（`$mount`）、`:1657-1660`（`enqueue`） | **（最严重）在 `apply` 里 await `$mount` 会插进启动序列，堵住 `sessions` 等内置命名空间 → 新会话能打开但消息发不出去** |
| **F6** | Remote 调用返回**信封**：成功 `{ok:true, value}`，失败 `{ok:false, error:{code,message}}` | 同上 `:1425-1446`（`rpcFailure` 与成功分支） | 不拆包 → 读到 `undefined`，表现为「通道通了但内容为空」 |
| **F7** | Gateway **每次派发**都校验服务对象上的 `typertRemote` 绑定：`{service, serviceKey, namespace}`，且 `value.service === original` | `dsh-api-gateway/lib/index.js:1450-1462`（`validateBinding`）、`:969`（每次派发都调） | `gateway/binding-invalid`，**Host 方法从未被调用**（日志里什么都看不到） |
| **F8** | 每个参数的 codec **必须** `mode === 'strict'`；`src-json` 只能用于 `result` | `dsh-api-gateway/lib/client.js:2067-2075`（`requireStrictInputs`） | `$mount 失败：field "x" has no strict codec` |
| **F9** | 设置页表单只投影 `.volatile()` 字段；**零 volatile 字段的条目会被 `describe()` 整条丢弃**；volatile 变更**不重挂 fiber**，只 `updateVolatile` + `loader/volatile-update` | `dsh-settings/lib/index.js:417-419`、`:153-158`、`:507`、`:513-523`；`cordis-plugin-loader/lib/index.js:380-425` | 设置页看不到字段 / 改动不生效 |
| **F10** | `ctx.configForms.get(<loader entry id>)` 的 `ConfigForm` API：`getSnapshot()` / `set(field,value)` / `unset(field)` / `mutate(ops)`；`hooks.<name>` 变成组件的 `use<Name>(selector)` | `dsh-client-ui-settings/lib/types/client/config-form.d.ts`、`config-form-types.d.ts` | 设置页读写全废 |
| **F11** | config-editor 按 `id + name` 定位 patch 行；新建行时 `name` 写成**解析后的绝对 `file://` URL** | `dsh-config-editor/lib/index.js:91-123` | 手动改 `name` → 编辑器认不出、重复加行 |

> 事实表对**功能①②③**构成硬依赖；功能②（`tools/pre-execute` 静态放行）的细节见 §4。
> F5–F11 只影响**设置页与提示词文件通道**，不影响审查主流程。

这些事实的共同特点是：**失效方式是静默的**——不崩溃、不报错，就是不工作。
所以必须主动校验。

---

## 2. 当前适配矩阵

| 插件版本 | 宿主版本 | 状态 | 备注 |
|---|---|---|---|
| 0.1.0 | `0.2.0-rc.2` | ✅ 已验证 | 基于 pnpm store `@deepseek-ai+dsh@0.2.0-rc.2_6751…` 逐行阅读核实 |
| 0.1.1 | `0.2.0-rc.2` | ✅ 已验证 | 修 0.1.0 的设置页「保存失败」：`defaultPreset` 开关把布尔透传给 `'auto' \| 'off'` 联合类型字段（见 §7） |
| 0.1.1 | `0.2.1-rc.2` | ✅ 已验证 | 下载 0.2.1-rc.2 的六个厂商包（auto-review / permission-presets / api-gateway / settings / client-ui-settings / config-editor）逐条核对 F1–F11 全部成立；同时把版本判定从「精确一条」改成「区间」 |
| **0.2.0** | `0.2.0-rc.2` | ✅ 已验证 | **新增功能④拒绝记录 + ⑤会话页签 + 会话级提示词**。都建立在**已有**内部事实上（判决形状 F12、右栏扩展点 F13），不需要新宿主能力；F1–F11 全部沿用。`scripts/denial-session-test.mjs` 46 项 + 既有 164 项全通过 |

### 2.0.1 0.2.0 新增依赖的两条内部事实

| # | 我们依赖的内部事实 | 出处（0.2.0-rc.2） | 一旦改动会怎样 |
|---|---|---|---|
| **F12** | `tools/pre-execute` 的 waterfall 返回值形状为 `{kind:'allow' \| 'deny' \| 'ask' \| 'cancel', reason?, info?}`；用 `prepend: true` 注册的监听器 `await next()` 拿到的**就是下游（含 auto review）的最终判决** | `dsh-tools/lib/index.js:3225`（`ctx.waterfall(...,"tools/pre-execute",exec,...)`）、`:3241-3253`（消费 `decision`） | 功能④取不到判决 → `denials.jsonl` 空；会话绑定也拿不到 `exec.agent.session` |
| **F13** | 右栏页签两阶段扩展点：`ctx.sidebarRightTabs.register({id, kind, priority, title, guide})` + `slots.register('sidebar.right.pane.tab', {key: id})` + 可选 `sidebar.right.pane.tab.title`；`openTab(kind)` 会展开面板 | `dsh-client-ui-sidebar-right/README.md`「Extension seats」、`lib/types/client/tab-registry.d.ts`、`lib/types/client/contract/slots.d.ts` | 功能⑤不出现或页签空白；**不影响设置页** |

> 两条都是**可选**依赖，缺了不崩溃：
> `sidebarRightTabs` / `sidebarRight` 用 `ctx.inject` 惰性获取，缺服务时页签静默不提供；
> F12 若失效，判决落不进 `denials.jsonl`，但**放行/审查主流程不受影响**
> （记录包在 `try/catch` 里，任何异常都不改变判决）。

**兼容区间**：`>=0.2.0 <0.3.0`（同一 minor 内的补丁与预发布版本都接受）。
判定只比 `major.minor`，不看 `-rc.N` 标签；`lib/compat.js` 的
`VERIFIED_HOST_VERSIONS` 记录**逐点核对过**的版本，未列的区间内版本按不告警处理。

### 2.1 0.2.1-rc.2 的核对结论（为什么敢声明兼容）

| 事实 | 0.2.1-rc.2 现状 | 判定 |
|---|---|---|
| **F1** `REVIEW_POLICY` 开头 | 第 20 行起仍为 `REVIEW_POLICY⏎You are the final authorization reviewer…` | ✅ 未变 |
| **F2** 四段拼接 | `reviewUserText()` 仍依次拼 `ENVIRONMENT / PROJECT_INSTRUCTIONS / FILTERED_HISTORY / PENDING_ACTION` | ✅ 未变 |
| **F3** 判决协议 | `readDecision()` 仍是「零或多个 reasoning + 一个 text + 终止 finish(stop)」；`parseDecision()` allow 形态仍是 `{risk, decision}` 两成员 | ✅ 未变 |
| **F4** `auto` 保留名 | `AUTO_PRESET = "auto"`；`names` 仍含 auto；`defaultOptions` 仍不含 | ✅ 未变 |
| **F5** `$mount` 串行队列 | `async $mount(contribution)` 仍走 `this.enqueue(...)` | ✅ 未变 |
| **F6** 信封形状 | 失败仍是 `{ok:false, error:rebuiltFailure(...)}`，成功仍是 `{ok:true, value:…}` | ✅ 未变 |
| **F7** typert 绑定校验 | `validateBinding()` 仍 `Reflect.get(original,"typertRemote")` 并比对 service/serviceKey/namespace | ✅ 未变 |
| **F8** 参数 codec strict | `requireStrictInputs()` 仍要求 `codec.mode === "strict"` | ✅ 未变 |
| **F9** volatile 投影 | `volatileForm()` / `isVolatilePath()` 仍在，零 volatile 字段仍抛 `has no volatile fields` | ✅ 未变 |
| **F10** ConfigForm API | `status/writable` 与 `set/unset/mutate` 签名不变 | ✅ 未变 |
| **F11** config-editor 行定位 | 仍按 `id`，且 `name` 不匹配时不认该行（`(!item.has("name") || … === entry.options.name)`） | ✅ 未变 |

> ⚠️ **唯一的结构性变化**：`dsh-api-gateway` 把 `lib/client.js` 拆成了
> `lib/client.browser.js` + `lib/client.node.js`。逻辑未变，但**文档里的行号引用会失效**——
> 引用位置时请按文件名+符号名检索，别按旧行号。本插件代码本身不受影响
> （我们只用运行时 API，不 import 这些文件）。

### 2.2 已经落在区间外时会怎样

`0.1.5-rc.3`、`0.3.x` 等**不在** `>=0.2.0 <0.3.0` 内的版本会在装载时告警
（`probe.log` 记 `host-versions: MISMATCH`）。此时先跑 `check-compat` 与 §6 冒烟；
不兼容就按 §3.3 改适配点并发布新插件版本。

**验证过的包版本**（`lib/compat.js` 的 `VERIFIED_PACKAGES`，**只用于诊断输出，不参与判定**）：

```
# 功能①②③ 的判定基础（0.2.0-rc.2 与 0.2.1-rc.2 均已核对）
@deepseek-ai/dsh-experimental-auto-review  0.2.0-rc.2 / 0.2.1-rc.2
@deepseek-ai/dsh-permission-presets        0.2.0-rc.2 / 0.2.1-rc.2
@deepseek-ai/dsh-llm                       0.2.0-rc.2
@deepseek-ai/dsh-session                   0.2.0-rc.2
@deepseek-ai/dsh-workspace                 0.2.0-rc.2

# 设置页与提示词文件通道（F5–F11）
@deepseek-ai/dsh-api-gateway               0.2.0-rc.2 / 0.2.1-rc.2
@deepseek-ai/dsh-settings                  0.2.0-rc.2 / 0.2.1-rc.2
@deepseek-ai/dsh-client-ui-settings        0.2.0-rc.2 / 0.2.1-rc.2
@deepseek-ai/dsh-typert-protocol           0.2.0-rc.2
@deepseek-ai/dsh-typert-registry           0.2.0-rc.2
```

> 判定不看这张表（否则每次宿主发补丁都要改代码）。它只写进 `probe.log` 便于排查。

---

## 3. 宿主升级后的复验流程（必做）

### 3.1 一键自检（先跑这个）

```bash
node lib/manage.js check-compat
```

期望输出：

```
审查请求识别（正例）：PASS
主对话请求识别（应判否）：PASS
```

任一项 FAIL → **功能②③已失效**，进入 3.2。

### 3.2 源码校验（check-compat 失败或宿主大版本变更时）

定位厂商包（**不要写死 store 哈希，每次现查**）：

```powershell
$base = "D:\Program Code\NodeLib\global\v11\<当前版本目录>\node_modules\.pnpm"
Get-ChildItem $base -Directory | Where-Object { $_.Name -like '@deepseek-ai+dsh-experiment*' } | ForEach-Object {
  Get-ChildItem (Join-Path $_.FullName 'node_modules\@deepseek-ai') -Directory |
    Where-Object { $_.Name -in @('dsh-experimental-auto-review','dsh-permission-presets') } |
    Select-Object -ExpandProperty FullName
}
```

逐条核对 F1–F4：

| 检查项 | 怎么查 | 通过判据 |
|---|---|---|
| **F1** 审查 system 开头 | 搜 `const REVIEW_POLICY = ` | 下一行仍以 `You are the final authorization reviewer` 开头 |
| **F2** 四段拼接 | 搜 `reviewUserText` | 仍依次拼 `ENVIRONMENT / PROJECT_INSTRUCTIONS / FILTERED_HISTORY / PENDING_ACTION` |
| **F3** 判决协议 | 搜 `readDecision` 与 `parseDecision` | 仍是「一到多个 reasoning + 一个 text + finish(stop)」；allow 形态仍是 `{risk, decision}` 两成员 |
| **F4** auto 保留名 | 搜 `AUTO_PRESET` 与 `registerAuto` | `names` 仍含 auto；`defaultOptions` 仍不含 auto |

### 3.3 不兼容时怎么办

1. **不发新版也不要紧的降级**：F1 失配只是让功能③静默失效，不影响宿主；
   插件会打 warn 日志（`拦截审查请求时出错` 或识别不到）。
2. **必须发新版的情况**：
   - F1/F2 变了 → 改 `lib/compat.js` 的 `REVIEW_SYSTEM_FINGERPRINT` /
     `PROJECT_INSTRUCTIONS_ANCHOR`（以及 `cwdOfReviewText` 的锚点）
   - F3 变了 → 改 `lib/replay.js` 的重发流（注意：早期版本里的 `allowChunks()`
     已随"不吞请求、只注入"的设计一起删除，现在重发流原样转发 chunk）
   - F4 变了 → 改功能①的切换逻辑（`mountDefaultPreset`）
   - F5–F11 变了 → 见 §6
3. 改完跑 `node scripts/selftest.mjs` + `node scripts/client-structure-test.mjs`，
   全通过后在 §2 矩阵追加一行。

---

## 4. `tools/pre-execute` 静态放行：我们确实用它，且不依赖顺序

### 4.1 现在的做法

文件类工具的静态放行**就注册在 `tools/pre-execute`**，用 `{ prepend: true }`：

```js
child.on('tools/pre-execute', async (exec, next) => {
  if (!configReader.read().allowRules) return await next()
  if (exec.agent === undefined || exec.parent !== undefined) return await next()  // 只处理根调用
  const verdict = await decide({ toolName: exec.name, args: exec.arguments, cwd })
  if (verdict.action === 'allow') return { kind: 'allow' }     // ← waterfall 提前结束
  return await next()
}, { prepend: true })
```

### 4.2 但**不依赖**"排在 auto-review 之前"

`prepend` 只是布尔，`hooks.unshift(...)` vs `push(...)`（`cordis/lib/index.js:336`），
并不能表达优先级；而且 auto-review 会因服务补齐反复重注册，把我们挤到它后面。
这些都**不影响本功能**，因为：

**我们的监听器命中时直接 `return { kind: 'allow' }`，waterfall 就此结束**——排在我们
后面的监听器（包括 auto-review 的 `await classifyRisk`）根本不会被调用。顺序只在
"我们不命中"时才起作用，而那时我们本来就要交给下游。

### 4.3 关键安全事实：短路跳不过 guard

waterfall 提前返回 allow **不等于**跳过工具守卫。宿主 `dsh-tools/lib/index.js`：

```js
const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason
```

即无论 waterfall 里是谁（我们、auto-review、还是没人）返回 `allow`，
`guardReason(exec)` 都照常执行。所以静态放行不会绕过任何 guard 判定。

### 4.4 供应商侧唯一的 guard 与路径无关

`dsh-subagent-in-process-driver` 的"结构化输出已完成"守卫，与路径无关；
对它来说，我们的静态放行与 auto-review 的 allow 是同一条路径上的同一个结果。

### 4.5 依赖的宿主事实

见 [§1 的事实表](#1-为什么需要这份文件)（F1–F4）与
[§1.1](#11-设置页与提示词文件通道的依赖f5f11)（F5–F11）。
**这里不再复制一份**——重复的表格会在下次更新时漂移。

功能②（`tools/pre-execute` 静态放行）只依赖公开的 `tools` 服务与
`exec.name/arguments/parent/agent.session.header.cwd` 形状，
**不依赖上面任何一条厂商事实**。

---

## 5. 已知限制

| 限制 | 说明 |
|---|---|
| `PROJECT_INSTRUCTIONS` 是 constraint | REVIEW_POLICY 明文：constraint **只能收窄**，不能授权；任何指令都不能降低风险等级。所以提示词能让审查更准、更少误判，但**不能让 medium 变 low**。 |
| 工作区档只能按 `ENVIRONMENT.cwd` 匹配 | 审查请求里没有 `workspaceId`，所以工作区档靠 `meta.json` 的 path 与 `ENVIRONMENT.cwd` 做祖先/相等匹配，多命中取路径最长者。cwd 拿不到时只注入全局档。 |
| 命令类工具没有静态放行 | 命令的副作用无法静态判定，一律交给 auto review；已删除的正则白名单与静态底线不再提供任何"免审白名单"能力。 |
| `run_code`（PTC）外层盲区 | auto-review 有意跳过 `run_code` 外层；静态放行也只处理根调用（`exec.parent === undefined`）。 |
| 审查器失败即拒绝 | 若我们把审查流改坏，auto-review 会以 `review failed` 拒掉调用。这是 F3 必须严格对齐的原因。 |

---

## 6. 设置页与提示词文件通道的升级检查清单（F5–F11）

宿主升级后，**除了 §3 的 `check-compat`，还要按本节复验设置页**。
这一组失配的症状是「界面看着正常，但某个操作没反应」，不崩溃、不报错。

### 6.1 一键冒烟（最快）

```powershell
# 1. 插件是否装载、Remote 是否注册（应看到 5 条 invocation）
Get-Content "$env:DSH_HOME\auto-review\probe.log" -Tail 20 | Select-String "apply-enter|apply-done|prompt-remote"

# 2. 设置页打开后：提示词区是否有内容、能否保存、保存后文件是否变化
Get-Content "$env:DSH_HOME\auto-review\prompts\global.md" -Raw
```

**三项都正常 = F5–F11 未受影响**，可以跳过本节。

### 6.2 逐条核对

| 编号 | 怎么查 | 通过判据 |
|---|---|---|
| **F5** | 在 `dsh-api-gateway/lib/client.js` 搜 `async $mount(` 与 `enqueue(` | `$mount` 仍经 `enqueue` 串行；且我们的 `client.js` 的 `apply` **仍然是同步的**（本插件自己的约束，别被"顺手改成 async"） |
| **F6** | 搜 `rpcFailure(` | 失败仍是 `{ok:false, error:{code,message}}`；成功分支仍返回 `{ok:true, value}` |
| **F7** | 搜 `validateBinding(` | 仍 `Reflect.get(original, 'typertRemote')`，且仍比较 `service` / `serviceKey` / `namespace` |
| **F8** | 搜 `requireStrictInputs(` | 仍要求参数 `codec.mode === 'strict'`（`src-json` 仍只允许用在 result） |
| **F9** | 搜 `isVolatilePath` / `volatile` 投影 | 仍只投影 volatile 字段；零 volatile 字段的条目仍被丢弃 |
| **F10** | 看 `dsh-client-ui-settings/lib/types/client/config-form-types.d.ts` | `ConfigFormSnapshot` 仍有 `status/value/writable`；`ConfigForm` 仍有 `set/unset/mutate` |
| **F11** | 看 `dsh-config-editor/lib/index.js` 的行定位逻辑 | 仍按 `id + name` 定位；**仍不要把 patch 里那条 `name` 手改成相对路径** |

### 6.3 兼容性断裂时改哪里

| 断的项 | 改这个文件 |
|---|---|
| F5 | `client.js` 的 `apply` / `mountPromptRemote`（保持同步 + 惰性挂载） |
| F6 | `client.js` 的 `unwrapRemote()` / `describeRemoteFailure()` |
| F7 | `lib/index.js` 的 `mountPromptRemote()` 里 `Object.defineProperty(face, 'typertRemote', …)`；或改用官方 `TypertRemoteService` |
| F8 | `lib/typert.js` 的 `stringParam()`（Host 真 zod）+ `client.js` 的 `stringCodec()`（客户端 stub） |
| F9 | `lib/schema.js`（确保新字段都 `.volatile()`） |
| F10 | `client.js` 里所有 `form.set/unset/mutate` 与快照读取 |
| F11 | 无代码可改——这是**用户操作禁令**，只能写进文档 |

### 6.4 三个最容易重新踩回去的坑

宿主升级后做适配时，**这三条是我们自己写代码时最容易破坏的**：

```
1. 客户端 apply 里绝不能 await $mount
   —— 会插进启动的全局串行队列，堵住 sessions 等内置命名空间，
      症状是「新会话能打开但消息发不出去」。惰性挂载是唯一安全写法。

2. Remote 返回值必须解 {ok, value} 信封
   —— 不拆包读到 undefined，症状是「通道通了但输入框是空的」。

3. Host 服务对象必须有 typertRemote 绑定，参数 codec 必须 strict
   —— 否则 gateway/binding-invalid 或 has no strict codec，
      症状是「Host 方法从未被调用、日志里什么都没有」。
```

### 6.5 诊断工具

```powershell
# 会话事件日志（zstd 是分帧写的，普通解压只读到第一帧）
node scripts/read-session-log.mjs "$env:DSH_HOME\sessions\<工作区转义名>\session-xxx\session.v4.jsonl.zstd"

# 设置页结构性检查（不启动浏览器，35 项，含开关取值映射回归）
node scripts/client-structure-test.mjs
```

---

## 7. 已修的设置页 bug：开关布尔值 vs 联合类型字段（0.1.1）

### 7.1 症状

「设置 → Auto Review」里切换**「新会话默认启用 Auto review」**开关，红色横幅报
**「保存失败」**，值不落盘。页面渲染正常，控件与当前值都能显示。

### 7.2 根因

设置页的开关组件（`Switch` → `ToggleRow`）**只产出布尔值**，但 `lib/schema.js` 里
`defaultPreset` 是字符串联合类型：

```js
defaultPreset: z.union(['auto', 'off']).default('off')…
```

0.1.0 的 `toggle()` 把开关给的 `true/false` **原样**交给 `setField`，宿主 schema
校验直接拒绝（探针抓到的真实报错）：

```
ValidationError: invalid config:
  - $.defaultPreset expected "auto" | "off" but got true
```

旁证：同为开关的 `allowRules` / `prompts` 是 `z.boolean()`，从未报错——只有联合类型
的那一个坏。也就是说 **UI 控件的取值类型必须与 schema 字段类型对齐**，这是本插件
自己的一层映射责任，宿主不会替我们转。

### 7.3 修法（0.1.1）

`client.js` 里引入**一张显式映射表**，`toggle` 一律经它转换后再提交：

```js
const BOOLEAN_FIELD_VALUES = Object.freeze({
  defaultPreset: { on: 'auto', off: 'off' },
})
const fieldValue = (field, next) => {
  const mapping = BOOLEAN_FIELD_VALUES[field]
  return mapping === undefined ? next : next ? mapping.on : mapping.off
}
// …
accepted = (await setField(field, fieldValue(field, next))) === true
```

**为什么用表而不是在调用点写 `next ? 'auto' : 'off'`**：表把「字段类型」这个
知识集中到一处，新增联合类型字段时只要不改表就会被回归测试抓到。对应测试在
`scripts/client-structure-test.mjs` 的「开关取值映射」一节：它会扫 `lib/schema.js`
里所有含 `.union(` 的字段，逐个断言已登记，**漏登记即测试失败**。

### 7.4 复验方法

1. `node scripts/client-structure-test.mjs` → 35 项全绿
2. 重启 DSH，进设置页点该开关 → 显示「已保存」，且
   `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 的 `auto-review-custom` 条目
   出现 `defaultPreset: auto` / `off`


