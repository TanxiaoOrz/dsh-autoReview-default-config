# 发布方案 · dsh-auto-review-custom v0.1.0

> 本文是**这一次首发**的具体执行计划，可逐条照着做。
> 长期维护手册（安装/验证/四级回退）见 [PUBLISHING.md](./PUBLISHING.md)；
> 宿主兼容性见 [VERSIONS.md](./VERSIONS.md)。
>
> ⚠️ 本文**不随包发布**（不在 `package.json` 的 `files` 里），只留在工作区。

---

## 0. 发布物元信息

| 项 | 值 |
|---|---|
| 包名 | `dsh-auto-review-custom` |
| 版本 | `0.1.0` |
| 适配宿主 | `0.2.0-rc.2` |
| 包名占用 | ✅ **已验证可用**（registry 查无此包） |
| 打包文件数 | **18**（解包 187.7 KB，tgz 64.5 KB；含 npm 自动并入的 `LICENSE`） |
| tarball | `dsh-auto-review-custom-0.1.0.tgz` |
| shasum | `340dd48ce85cbc5c73eeb81332c8390f104ccc6c` |

---

## 1. ⚠️ 先解决 registry（否则发布会失败）

本机 `npm config get registry` 是：

```
https://registry.npmmirror.com/
```

**淘宝镜像是只读的，不能发布。** 所有发布命令都必须显式带 `--registry`，
否则会打到镜像上并报 `ENEEDAUTH` 或 `403`。

另外当前 **未登录**（`npm whoami` → `ENEEDAUTH`）。

---

## 2. 发布前检查清单（必须全绿）

### 2.1 代码与测试

```powershell
cd "D:\Program Code\plugins\AutoReviewCustom"

node scripts/client-structure-test.mjs    # 期望：通过 29 项，失败 0 项
node scripts/selftest.mjs                 # 期望：通过 40 项，失败 0 项
node scripts/prompt-store-test.mjs        # 期望：通过 40 项，失败 0 项
node scripts/retry-test.mjs               # 期望：通过 38 项，失败 0 项
node scripts/replay-test.mjs              # 期望：重发逻辑全部通过
node scripts/e2e-sim.mjs                  # 期望：端到端模拟全部通过
node bin/manage.mjs check-compat          # 期望：两项都 PASS
```

- [ ] 六套测试全绿
- [ ] `check-compat` 双向 PASS

### 2.2 已装副本与源码一致

改动源码后**必须重新复制**到已装目录（安装是真实目录拷贝，不是符号链接）。

```powershell
$nm = "$env:DSH_HOME\profiles\web\node_modules\dsh-auto-review-custom"
$all = @('lib\index.js','client.js','lib\typert.js','lib\prompt-store.js','lib\schema.js',
         'lib\replay.js','lib\rules.js','lib\prompts.js','lib\compat.js','lib\config.js',
         'lib\manage.js','README.md','VERSIONS.md','PUBLISHING.md','package.json')
foreach ($f in $all) {
  $a = (Get-FileHash $f -Algorithm MD5).Hash
  $b = (Get-FileHash "$nm\$f" -Algorithm MD5).Hash
  if ($a -ne $b) { "不一致: $f" }
}
```

- [ ] 无「不一致」输出

### 2.3 真实环境冒烟（重启后）

```powershell
Get-Content "$env:DSH_HOME\auto-review\probe.log" -Tail 12 | Select-String "apply-enter|apply-done|prompt-remote|gate-passed|llm-injected"
```

期望看到（pid 会不同）：

```
apply-enter
prompt-remote: provided autoReviewPrompts
prompt-remote: typert-registered 5 invocations
apply-done
gate-passed(initial)
llm-injected: llm/stream listener mounted
```

- [ ] 无 `*-failed` / `*-missing`
- [ ] `typert-registered` 是 **5**
- [ ] 设置页能读写提示词、能保存

### 2.4 打包预览

```powershell
npm.cmd pack --dry-run
```

- [ ] **18 个文件**，无 `scripts/`、无 `*.tgz`、无 `.bak-*`、无 `.gitignore`/`.gitattributes`

---

## 3. 打包

```powershell
cd "D:\Program Code\plugins\AutoReviewCustom"
Remove-Item *.tgz -Force -ErrorAction SilentlyContinue
npm.cmd pack
```

产出 `dsh-auto-review-custom-0.1.0.tgz`。

**校验解包内容**：

```powershell
$tmp = Join-Path $env:TEMP "arc-pack-verify"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
tar -xzf "dsh-auto-review-custom-0.1.0.tgz" -C $tmp
Get-ChildItem "$tmp\package" -Recurse -File | ForEach-Object { $_.FullName.Replace("$tmp\package\", '') }
node --check "$tmp\package\lib\index.js"
node --check "$tmp\package\client.js"
Remove-Item $tmp -Recurse -Force
```

- [ ] 结构与上表一致，两个入口语法 OK

---

## 4. 分发路线（二选一或都做）

### 路线 A：发布到 npm（推荐，别人 `npm i` 即可）

```powershell
# 1. 登录（浏览器跳转授权，只需一次）
npm.cmd login --registry https://registry.npmjs.org/

# 2. 确认身份
npm.cmd whoami --registry https://registry.npmjs.org/

# 3. 发布
npm.cmd publish --access public --registry https://registry.npmjs.org/

# 4. 验证
npm.cmd view dsh-auto-review-custom version --registry https://registry.npmjs.org/
```

- [ ] `whoami` 返回你的账号
- [ ] `publish` 成功
- [ ] `view` 返回 `0.1.0`

**别人怎么装**：

```powershell
dsh plugin --profile web add dsh-auto-review-custom
```

### 路线 B：不分发 npm，直接给 tgz / 目录

```powershell
# 用 tarball 装
dsh plugin --profile web add "file:D:\path\to\dsh-auto-review-custom-0.1.0.tgz"

# 或用整个目录装（适合还在频繁改）
dsh plugin --profile web add "file:D:\Program Code\plugins\AutoReviewCustom"
```

- [ ] 对方安装后 `probe.log` 出现 `apply-done`

---

## 5. 装完必须做的事（两条）

**`dsh plugin` 不会自动维护 `dsh.profile.bundles`**，必须手动确认：

```powershell
node -e "const p=require('$env:DSH_HOME/profiles/web/package.json'); console.log(JSON.stringify(p.dsh.profile.bundles, null, 2))"
```

- [ ] 列表里有 `"dsh-auto-review-custom"`

没有就编辑 `$DSH_HOME\profiles\web\package.json`，在 `dsh.profile.bundles` 数组里加一行：

```json
"dsh-auto-review-custom"
```

然后**重启 `dsh web`**。

### 装后验证

- [ ] 设置里出现「Auto Review」一页
- [ ] 三个开关能切
- [ ] 提示词区能显示现有内容、能保存、保存后顶部出现「✓ 已保存」
- [ ] 新会话默认进入 auto（若开了开关）
- [ ] 工作区内 `write` 不弹审查；工作区外 `write` 照常审查

---

## 6. 回滚

按严重程度从轻到重：

| 层级 | 操作 | 是否重启 |
|---|---|---|
| 1 | **设置 → Auto Review** 关掉三个开关；或编辑 patch 的 `config` 块 | 否 |
| 2 | `$DSH_HOME\profiles\web\package.json` 的 `dsh.profile.bundles` 里删掉包名 | 是 |
| 3 | `dsh plugin --profile web remove dsh-auto-review-custom` + 手动清 bundles | 是 |
| 4 | 用 §2 安装前的备份还原 `package.json` + `pnpm install --frozen-lockfile` | 是 |

> ⚠️ **不要用 `node bin/manage.mjs set-config` 回退开关**——Config 默认值会遮住
> `config.json`，该命令会执行但不生效（命令本身会打印警告）。

---

## 7. 下一版本怎么发

1. 改 `package.json` 的 `version`
2. 重跑 §2 全部检查
3. 重跑 §3 打包
4. `npm.cmd publish --access public --registry https://registry.npmjs.org/`
5. 在 `VERSIONS.md` §2 的适配矩阵追加一行

**版本号约定**：

| 变更类型 | 版本 |
|---|---|
| 适配新的宿主版本 | 次版本号 +1（`0.1.0` → `0.2.0`） |
| 修 bug / 改文案 | 修订号 +1（`0.1.0` → `0.1.1`） |
| 破坏性改配置字段 | 主版本号 +1（`0.1.0` → `1.0.0`） |

---

## 8. 发布前必须知晓的风险

| 风险 | 影响 | 现状 |
|---|---|---|
| **深度依赖宿主内部实现** | F1–F11 任一改动都会**静默失效**（不崩溃、不报错） | ✅ 已加**运行时版本告警**：`apply` 里比对 `process.argv[1]` 推导出的 `@deepseek-ai/dsh` 版本与 `SUPPORTED_HOST_VERSION`，不一致就 warn（`probe.log` 记 `host-versions: MISMATCH`） |
| 用户不会主动跑 `check-compat` | 装错版本后「莫名其妙不工作」 | ✅ 同上，装载时当场告警 |
| Windows 路径语义 | 静态放行复刻了沙箱的 `dev+ino` 上溯，**Linux/macOS 未实测** | README 已注明仅 Windows 验证 |
| 提示词内容是中文 | 社区用户看不懂示例 | 建议 README 补英文示例 |
| config-editor 会改写 patch 的 `name` | 用户手改成相对路径会导致重复加行 | 已在 README「已知限制」注明 |

**首发的建议**：先走 **路线 B**（tgz / 目录）在自己的其它 profile 和一个干净环境上各装一次，
确认 §5 的验证项都过，再走路线 A 发 npm。

---

## 9. 当前状态

| 步骤 | 状态 |
|---|---|
| §2 测试全绿 | ✅ 已通过（29+40+40+38+replay+e2e） |
| §2 已装副本一致 | ✅ 15 个文件一致 |
| §2 真实环境冒烟 | ✅ `typert-registered 5 invocations`、提示词注入命中 |
| §3 打包 | ✅ `dsh-auto-review-custom-0.1.0.tgz` 已生成并解包复验 |
| §4 分发 | ⬜ 未执行（等你决定走哪条路线） |
| §5 bundles 登记 | ⬜ 本机已登记；分发后需对端确认 |
