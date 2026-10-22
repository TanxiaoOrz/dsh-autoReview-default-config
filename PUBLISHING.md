# 发布与安装手册

> **首发执行计划**（逐条照着做、带勾选框的那种）见 [RELEASE-PLAN.md](./RELEASE-PLAN.md)。
> 本文是**长期维护手册**：安装、验证、四级回退、发布规格。
>
> 适用版本：`dsh-auto-review-custom@0.1.0`，适配宿主 `0.2.0-rc.2`
> 本文所有命令都在 **Windows + PowerShell** 下验证过。

---

## 1. 安装（本地测试）

### 1.1 前置检查

插件只在 **auto review 可用**时才启动。先确认：

```powershell
cd "$env:DSH_HOME\profiles\web"
Select-String -Path package.json -Pattern "experimental-auto-review"
```

**必须有输出**。如果没有，先在插件面板里启用 `@deepseek-ai/dsh-experimental-auto-review`。

> 你的 `web` profile 已包含它，`desktop` profile 没有。**本插件应该在 `web` profile 里装。**

### 1.2 安装前先备份（必做）

```powershell
$profile = "$env:DSH_HOME\profiles\web"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

Copy-Item "$profile\package.json"        "$profile\package.json.bak-$stamp"
Copy-Item "$profile\pnpm-lock.yaml"      "$profile\pnpm-lock.yaml.bak-$stamp"
Copy-Item "$profile\cordis.patch.yml"    "$profile\cordis.patch.yml.bak-$stamp"

Write-Host "已备份，时间戳：$stamp" -ForegroundColor Green
```

**把这个时间戳记下来**，回退时要用（见 §3）。

### 1.3 安装

#### 方式 A：本地目录（开发调试用）

```powershell
dsh plugin --profile web add "file:D:/Program Code/plugins/AutoReviewCustom"
```

> ### ⚠️ 本地安装是「实体拷贝」，不是软链
>
> 实测：装完后 `profiles/web/node_modules/dsh-auto-review-custom` 是一份
> **普通目录拷贝**，不是 junction / symlink。这意味着：
>
> **你改了源码目录的代码，运行时那份不会自动更新。**
>
> 改完代码后必须二选一：
>
> ```powershell
> # 方式 1：重新装一次（最干净）
> dsh plugin --profile web add "file:D:/Program Code/plugins/AutoReviewCustom"
>
> # 方式 2：手动同步（快速迭代）
> Copy-Item "D:\Program Code\plugins\AutoReviewCustom\lib\*" `
>           "$env:DSH_HOME\profiles\web\node_modules\dsh-auto-review-custom\lib\" -Recurse -Force
> Copy-Item "D:\Program Code\plugins\AutoReviewCustom\cordis.patch.yml" `
>           "$env:DSH_HOME\profiles\web\node_modules\dsh-auto-review-custom\" -Force
> ```
>
> 改完都要**重启 dsh web**。

#### 方式 B：tgz 包（更接近真实发布形态）

```powershell
# 先打包
cd "D:\Program Code\plugins\AutoReviewCustom"
npm.cmd pack
# → 生成 dsh-auto-review-custom-0.1.0.tgz

# 再装
dsh plugin --profile web add "file:D:/Program Code/plugins/AutoReviewCustom/dsh-auto-review-custom-0.1.0.tgz"
```

#### 方式 C：从 npm 装（发布后）

```powershell
dsh plugin --profile web add dsh-auto-review-custom
```

#### 方式 D：从 GitHub 装（不发 npm 也能分享）

```powershell
dsh plugin --profile web add "github:你的账号/AutoReviewCustom"
```

> ⚠️ git 托管的包安装时要跑 `prepare` 构建脚本，pnpm 默认拦截。
> 报错时会提示你把 key 加进 `profiles/web/pnpm-workspace.yaml` 的 `allowBuilds`。
> 本包**没有构建步骤**，通常不会触发。

### 1.4 确认已登记为 bundle

```powershell
cd "$env:DSH_HOME\profiles\web"
Select-String -Path package.json -Pattern "dsh-auto-review-custom"
```

期望看到**两处**：

1. `dependencies` 里有 `"dsh-auto-review-custom": "file:..."` 或 `"^0.1.0"`
2. `dsh.profile.bundles` 数组里有 `"dsh-auto-review-custom"`

**如果 `dsh.profile.bundles` 里没有**，手动加（注意 JSON 逗号）：

```jsonc
"dsh": {
  "profile": {
    "bundles": [
      "...",
      "@memtensor/memos-local-plugin",
      "dsh-auto-review-custom"     // ← 加这一行
    ],
    "patchReload": "live"
  }
}
```

### 1.5 重启 dsh web

按你平时的方式重启。重启后**立即检查日志**。

---

## 2. 验证（按顺序做，每步都要看到预期结果）

### 2.1 插件是否装载

日志里应有：

```
[auto-review-custom] 已装载，适配宿主 0.2.0-rc.2，数据目录 D:\agent\DeepseekHarness\dsh-home\auto-review
```

| 看到的日志 | 含义 | 怎么办 |
|---|---|---|
| 上面这行 | ✅ 正常 | 继续 2.2 |
| `未检测到可用的 auto 预设（auto review 未启用），插件不启动` | auto review 没启用 | 启用 auto review 后重启 |
| **什么都没有** | bundle 没挂上 | 检查 1.4 的 `bundles` 数组 |

### 2.2 自检

```powershell
cd "D:\Program Code\plugins\AutoReviewCustom"
node bin/manage.mjs doctor
node bin/manage.mjs check-compat
```

期望：`结论：未发现致命问题` + `PASS / PASS`。

### 2.3 验证功能②③（**在单个会话里**，不动全局默认）

1. 在 DSH 里新开一个会话
2. 手动切到 Auto review：`/permission auto`
3. 先写一条提示词 —— **打开 设置 → Auto Review，在「全局提示词」里写**
   （CLI 等价写法：`node bin/manage.mjs set-global --text "..."`，两边操作同一批文件）
4. 在会话里让 agent 跑个普通命令（如 `git status`），**仍然会审查**
   ——命令类工具永远交给 auto review，没有免审白名单
5. 让 agent 在会话工作目录内写一个文件（如 `write` 到 `<cwd>\tmp-note.txt`），
   **应该不弹审查卡片、直接执行**（文件类工具 + 目标在沙箱可写根内 = 静态放行）；
   写到工作目录之外（如 `C:\Windows\Temp\x.txt`）则**照常审查**
6. 看审计记录确认静态放行确实发生：

```powershell
Get-Content "$env:DSH_HOME\auto-review\decisions.jsonl" -Tail 5
```

7. 工作区档可选自测：设置页「工作区提示词」里从下拉选一个已注册工作区 → 写提示词
   → 添加。CLI 等价写法：

```powershell
node bin/manage.mjs set-workspace --path "D:\Program Code\plugins\AutoReviewCustom" `
                                  --text "本仓库是 DSH 插件，改完必跑 selftest"
node bin/manage.mjs list      # 应能看到该档及其 path
```

8. 顺带确认设置页本身：开关能切、提示词能读能存、保存后顶部出现绿色
   「✓ 已保存」横幅


### 2.4 验证功能①（**最后做**）

⚠️ **这一步会让你所有新会话都进入 auto 审查模式**。

**打开 设置 → Auto Review →「新会话默认启用 Auto review」**，保存即生效
（写入 `profiles/<profile>/cordis.patch.yml`，volatile 字段，不用重启）。

然后新开会话，检查权限投影：

```powershell
Get-ChildItem "$env:DSH_HOME\storages\session_projcache\sessions" -Filter "session-*.json" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 |
  Select-String -Pattern '"preset"' -Context 0,4
```

期望看到 `"preset": "auto"`。

**验证完如果不想常开**，回设置页把开关关掉。

---

## 3. 回退（出问题怎么办）

按**严重程度从轻到重**，四个层级。**只要能启动 DSH 就优先用 1 或 2。**

### 层级 1：只关功能，不卸插件（最快，无需重启）

**首选：设置 → Auto Review**，把对应开关关掉即可（写入
`profiles/<profile>/cordis.patch.yml`，volatile 字段，不用重启）。

等价的手工改法——直接编辑那个 patch 文件的 `auto-review-custom` 条目：

```yaml
- id: auto-review-custom
  name: file:///.../node_modules/dsh-auto-review-custom/lib/index.js
  config:
    defaultPreset: off     # 新会话默认 auto → 关
    prompts: false         # 提示词注入 → 关
    allowRules: false      # 文件类工具静态放行 → 关
```

> ⚠️ **不要用 `node bin/manage.mjs set-config`**：这三个开关已经由设置页接管，
> Config schema 的默认值会遮住 `config.json`，该命令会执行但**不生效**（命令本身
> 会打印警告）。`set-global` / `set-workspace` / `rm-workspace` 仍然有效——它们
> 操作的是提示词文件，和设置页是同一批文件。

### 层级 2：让 bundle 不加载（需要重启，不卸包）

编辑 `$DSH_HOME\profiles\web\package.json`，把 `dsh.profile.bundles` 里的
`"dsh-auto-review-custom"` **删掉或注释**（JSON 不支持注释，直接删这一行，注意前一行末尾逗号）。

> `patchReload` 是 `live`，改完**可能**自动重载；保险起见还是重启。

### 层级 3：完全卸载包

```powershell
dsh plugin --profile web remove dsh-auto-review-custom
```

#### ⚠️ 卸载后必须手动做的一步

`dsh plugin` **只转发给 pnpm**（源码 `plugin-BGnVfe_D.js` 确认为 `runPluginCommand` → pnpm），
它**不会**碰 `dsh.profile.bundles`。所以卸载后那一行会残留：

```powershell
# 检查残留
Select-String -Path "$env:DSH_HOME\profiles\web\package.json" -Pattern "dsh-auto-review-custom"
```

- **有输出** → 编辑 `profiles/web/package.json`，把 `dsh.profile.bundles` 里的
  `"dsh-auto-review-custom"` 那一行**手动删掉**（注意上一行末尾的逗号）
- 不删的后果：下次启动报
  `skipping profile bundle "dsh-auto-review-custom": cannot resolve profile bundle`
  （DSH 会跳过并打 warning，**通常不致命**，但日志会有噪音）

```powershell
# 快速打开编辑
notepad "$env:DSH_HOME\profiles\web\package.json"
```

还应清理数据目录（可选，保留也无害）：

```powershell
# 先看看有什么
Get-ChildItem "$env:DSH_HOME\auto-review" -Recurse -ErrorAction SilentlyContinue

# 确认无误再删
Remove-Item "$env:DSH_HOME\auto-review" -Recurse -Force -ErrorAction SilentlyContinue
```

**重启** dsh web。

### 层级 4：还原到安装前（彻底回滚）

> `dsh` **没有**还原 `package.json` / lockfile 的命令，这一步只能手工做。

用 §1.2 记下的时间戳：

```powershell
$profile = "$env:DSH_HOME\profiles\web"
$stamp = "20261017-XXXXXX"     # ← 换成你 §1.2 记下的时间戳

# 先确认备份都在
Get-ChildItem "$profile\*.bak-$stamp"

# 还原
Copy-Item "$profile\package.json.bak-$stamp"      "$profile\package.json" -Force
Copy-Item "$profile\pnpm-lock.yaml.bak-$stamp"    "$profile\pnpm-lock.yaml" -Force
Copy-Item "$profile\cordis.patch.yml.bak-$stamp"  "$profile\cordis.patch.yml" -Force
```

然后再按当前 `package.json` 重装依赖：

```powershell
cd "$env:DSH_HOME\profiles\web"
pnpm.cmd install --frozen-lockfile
```

**重启** dsh web。

### 🚨 如果 DSH 完全起不来

这是最坏情况。按这个顺序抢救：

```powershell
# 1. 先确认是不是本插件导致的：把 bundle 从列表里去掉
$profile = "$env:DSH_HOME\profiles\web"
notepad "$profile\package.json"
# → 删掉 dsh.profile.bundles 里的 "dsh-auto-review-custom"

# 2. 仍然起不来 → 还原 package.json（层级 4）
# 3. 还不行 → 用你的备份工具链还原整个 profile
```

> 本插件**理论上不会导致启动崩溃**：`apply()` 全程 try/catch，
> 任何失败都只打 warn。但以防万一，上面这套流程走一遍就够了。

---

## 4. 发布到 npm

### 4.1 先查包名是否被占

```powershell
npm.cmd view dsh-auto-review-custom version
```

- 报 `404` → ✅ 可用
- 有版本号 → ❌ 被占了，改名（见 4.2）

### 4.2 改名（如果被占）

改成带 scope 的形式，编辑 `package.json`：

```json
"name": "@你的npm用户名/dsh-auto-review-custom"
```

带 scope 的包**发布时必须加 `--access public`**，否则默认是私有的（要付费）。

### 4.3 发布前自检清单

```powershell
cd "D:\Program Code\plugins\AutoReviewCustom"

# 1. 打包预览：确认下面 18 个文件都在，没有多余文件
npm.cmd pack --dry-run

# 2. 五套测试全绿
node scripts/client-structure-test.mjs
node scripts/selftest.mjs
node scripts/prompt-store-test.mjs
node scripts/retry-test.mjs
node scripts/e2e-sim.mjs
node bin/manage.mjs check-compat

# 3. package.json 关键字段（客户端半区必须存在）
node -e "const p=require('./package.json'); console.log('name:',p.name); console.log('dsh.bundle:',JSON.stringify(p.dsh?.bundle)); console.log('dsh.client:',JSON.stringify(p.dsh?.client)); console.log('bin:',JSON.stringify(p.bin))"
```

期望 `pack --dry-run` 输出这些文件（共 18 个）：

```
LICENSE  PUBLISHING.md  README.md  VERSIONS.md  package.json  cordis.patch.yml
bin/manage.mjs  client.js
lib/compat.js  lib/config.js  lib/index.js  lib/manage.js
lib/prompt-store.js  lib/prompts.js  lib/replay.js  lib/rules.js
lib/schema.js  lib/typert.js
```

> `LICENSE` 不在 `files` 白名单里，但 npm **总是**自动包含它（约定文件名之一），
> 所以实际是 18 个而不是 17 个。
>
> `scripts/` 不在 `files` 里，**不会随包发布**——它们是开发期测试，需要工作区的
> `lib/` 才能跑，但**会**随 Git 仓库发布（见 README「仓库里放什么」）。
>
> `.gitignore` / `.gitattributes` **不随包发布**（npm 只自动并入 README、LICENSE、
> package.json 等约定文件），它们只服务于 Git 仓库。

### 4.4 `peerDependencies` 策略（重要）

当前写死 `0.2.0-rc.2`，**宿主升级后会装不上**。发布前建议放宽为：

```json
"peerDependencies": {
  "@deepseek-ai/dsh-llm": ">=0.2.0-rc.2 <0.3.0",
  "@deepseek-ai/dsh-permission-presets": ">=0.2.0-rc.2 <0.3.0",
  "@deepseek-ai/dsh-session": ">=0.2.0-rc.2 <0.3.0",
  "@deepseek-ai/dsh-tools": ">=0.2.0-rc.2 <0.3.0",
  "@deepseek-ai/dsh-workspace": ">=0.2.0-rc.2 <0.3.0"
}
```

> ⚠️ 放宽前先确认兼容性：`VERSIONS.md` 里的 F1–F4 四项事实没变才能放。
> 拿不准就保守写死，等宿主升级时发新版。

### 4.5 登录并发布

```powershell
cd "D:\Program Code\plugins\AutoReviewCustom"
npm.cmd login           # 浏览器登录
npm.cmd publish --access public
```

### 4.6 后续版本

```powershell
npm.cmd version patch    # 0.1.0 → 0.1.1
npm.cmd publish --access public
```

**每发一版，必须在 `VERSIONS.md` §2 的适配矩阵追加一行。**

---

## 5. 别人怎么装

### 5.1 关于"插件市场"的真相

DSH **没有**独立的插件市场服务器。我读过 `dsh-plugin-manager` 源码，
它的市场列表只来自两处：

1. 你 profile `package.json` 的 `dependencies`
2. DSH 自带的 `OPTIONAL_BUNDLES` 常量

**没有"从 npm 搜索全部 DSH 插件"的功能。**

所以完整流程是：

```
你发布到 npm（或推到 GitHub）
  →  别人执行 dsh plugin --profile web add <包名或地址>
  →  出现在他自己的插件面板列表里
```

### 5.2 别人可用的安装规格

`dsh plugin add` 和插件面板的安装入口接受**同一套**规格（源码 `install-spec.js` 确认）：

| 格式 | 示例命令 |
|---|---|
| npm 包名 | `dsh plugin --profile web add dsh-auto-review-custom` |
| 带版本 | `dsh plugin --profile web add dsh-auto-review-custom@0.1.0` |
| GitHub 简写 | `dsh plugin --profile web add "github:你的账号/AutoReviewCustom"` |
| Git URL | `dsh plugin --profile web add "https://github.com/你的账号/AutoReviewCustom"` |
| Git SSH | `dsh plugin --profile web add "git@github.com:你的账号/AutoReviewCustom.git"` |
| tgz（本地） | `dsh plugin --profile web add "file:D:/path/xxx.tgz"` |
| tgz（远程） | `dsh plugin --profile web add "https://.../xxx.tgz"` |

⚠️ **本地路径必须是绝对路径**，相对路径会被拒绝（报 `a local path must be absolute`）。
⚠️ 装完都要确认 `dsh.profile.bundles` 里有包名（`dsh plugin` 不会自动登记，见 §1.4）。

### 5.3 包被识别为 DSH 插件的条件

只要 `package.json` 里有：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

就会被识别为 bundle。**你的包已经有这个字段。**

---

## 6. 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| `pnpm add` 报 `ERR_PNPM_NO_MATCHING_VERSION` | `peerDependencies` 版本对不上 | 检查宿主版本，或放宽 peer 范围 |
| 日志无任何 `auto-review-custom` | bundle 没登记 | 见 §1.4 |
| `未检测到可用的 auto 预设` | auto review 没启用 | 启用后重启 |
| 提示词写了但不生效 | `prompts` 被关了，或文件为空 | `node bin/manage.mjs list` 检查 |
| 工作区档没生效 | `ENVIRONMENT.cwd` 不在该档 `meta.json` 的 path 之下，或 `note.md` 为空 | `node bin/manage.mjs list` 看 path；`doctor` 会报缺 `note.md` |
| 文件类工具仍在审查 | 目标路径不在沙箱可写根内（会话 cwd / `/tmp` / 系统临时目录） | 属预期行为；`decisions.jsonl` 里没有对应记录 |
| 审查器开始拒绝调用 | 注入后的请求格式与宿主不兼容 | 跑 `check-compat`，见 `VERSIONS.md` §3 |
| 本机 `npm` 命令报执行策略错误 | `npm.ps1` 被拦 | 用 `npm.cmd` |

---

## 7. 一句话总结

**安装**：`dsh plugin --profile web add "file:D:/Program Code/plugins/AutoReviewCustom"`
→ 确认 `dsh.profile.bundles` 里有包名 → 重启

**回退**：优先到 **设置 → Auto Review** 把三个开关关掉（写入 patch 的 volatile 字段，不重启）；
再不行 `dsh plugin --profile web remove dsh-auto-review-custom` + 手动删 bundles 里那一行；
彻底回滚用 §1.2 的备份还原 `package.json` + `pnpm.cmd install --frozen-lockfile`。

**发布**：`npm.cmd publish --access public`，但**先在真实 DSH 里验证过再发**。
