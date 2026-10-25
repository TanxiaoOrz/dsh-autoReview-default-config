/**
 * dsh-auto-review-custom —— Auto review 增强插件（Cordis 宿主插件）
 *
 * ## 三个功能
 *
 * **① 新会话默认进入 auto review**
 *   在 `session/created` 里，把**仍是宿主默认值**的新会话切到 `auto` 预设。
 *   已经被人改过、或属于恢复会话的，一律不动。
 *
 *   > 为什么不能直接把它设成"通用设置里的默认值"：宿主的 `permissionPresets`
 *   > 只允许配置表里的预设成为默认值，`auto` 是保留名，写进去会
 *   > `unknown default preset`，直接让会话创建失败。详见 VERSIONS.md。
 *
 * **② 文件类工具的静态放行**（`tools/pre-execute`）
 *   文件类工具（read/write/edit）且目标路径在**沙箱可写根**内 → 直接
 *   `return { kind: 'allow' }`，waterfall 提前结束，不弹审查卡片、不花 token。
 *   判定复用 DSH 沙箱语义（`writableRoots` = `[会话 cwd, /tmp, os.tmpdir()]`），
 *   所以不会出现"我们放行但沙箱拒绝"的冲突。
 *
 *   **命令类工具（`pwsh` 等）一律不处理**，原样交给 auto review 的 AI 判断——
 *   命令的副作用无法静态判定。这里没有正则白名单，也没有静态底线。
 *
 * **③ 审查提示词注入**（`llm/stream`）
 *   审查器每审一个工具调用就发一次 LLM 请求。我们在 `llm/stream` 拦截它，
 *   把「全局 `prompts/global.md` + 工作区 `prompts/workspace/<目录名>/note.md`」
 *   两档提示词追加进 `PROJECT_INSTRUCTIONS` 段，合成顺序全局在前、工作区在后。
 *
 *   能力上限：`PROJECT_INSTRUCTIONS` 在审查器眼里是 constraint，
 *   **只能收窄判断，不能授权**。要"某类命令根本不审"，只能靠功能②。
 *
 * ## 关于 `llm/stream` 改参（关键设计）
 *
 * `llm/stream` 是 cordis 的 **waterfall**，签名
 * `(options, next) => AsyncIterable<StreamChunk>`。`next()` **不接受参数**，
 * 而审查器构造的 `options` 是**深度冻结**的（实测 `Object.isFrozen() === true`），
 * 所以"就地改参再 next()"走不通。正确做法是构造**新对象**，用
 * `ctx.llm.stream(newOptions)` 重发，并用一个 Symbol 标记防止递归。
 *
 * 约束：只在**确认是审查请求**时改，其余一律原样 `return next()`。
 *
 * @module dsh-auto-review-custom
 */

import { mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { DEFAULT_CONFIG, createCachedReader, parseConfig } from './config.js'
import {
  checkHostVersions,
  injectPromptIntoReviewText,
  isReviewRequest,
  SUPPORTED_HOST_VERSION,
  userMessageText,
} from './compat.js'
import { appendDenial, queryDenials as queryDenialsFromFile } from './denials.js'
import { composePrompts, cwdOfReviewText, findWorkspaceId } from './prompts.js'
import {
  findWorkspaceDirName,
  readAllPrompts,
  removeWorkspacePrompt,
  writeGlobalPrompt,
  writeWorkspacePrompt,
} from './prompt-store.js'
import { replayStream } from './replay.js'
import { decide } from './rules.js'
import { findSessionCwd } from './session-cwd.js'
import {
  createSessionBinding,
  listSessionPrompts,
  readSessionPrompt,
  writeSessionPrompt,
} from './session-prompts.js'
import { NAMESPACE, TYPERT } from './typert.js'

export const name = 'auto-review-custom'

/**
 * 把 `Config` 暴露给 Loader。
 *
 * 声明它之后，`$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里本条目就可以有
 * `config:` 块，且设置页能通过 `ctx.configForms` 读写这些字段。
 * 全部字段都是 `.volatile()`——宿主的表单投影只收 volatile 字段。
 */
export { Config } from './schema.js'

/**
 * 惰性绑定：所有服务都用 `ctx.inject` 内部获取，顶层不声明 inject。
 *
 * 本插件对 `permissionPresets` 是**可选**依赖（desktop profile 可能没装
 * auto-review）。顶层声明会让缺服务时整插件停用；惰性绑定让门禁能自己判断。
 */
export const inject = []

/**
 * 读一个 volatile 配置引用（或普通值）。
 *
 * volatile 字段的变更**不会重挂插件 fiber**——Loader 把新值提交进正在运行的
 * 引用并 emit `loader/volatile-update`（`cordis-plugin-loader/lib/index.js:380-425`）。
 * 所以每次使用都必须现读 `.get()`，不能缓存。
 *
 * @param {any} ref - volatile 引用或普通值。
 * @param {any} fallback - 缺失时的回落值。
 * @returns {any}
 */
function readVolatile(ref, fallback) {
  try {
    if (ref === undefined || ref === null) return fallback
    if (typeof ref.get === 'function') {
      const value = ref.get()
      return value === undefined ? fallback : value
    }
    return ref
  } catch {
    return fallback
  }
}

/** 把任意字典值规整成 `Record<string, string>`。 */
function normalizePromptDict(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {}
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.trim().length > 0) out[key] = value
  }
  return out
}

/**
 * 挂载"提示词文件读写"的 Remote 通道。
 *
 * 浏览器调 `ctx.remote.autoReviewPrompts.*`，落到这里提供的方法上；
 * 方法本体是 `prompt-store.js` 里的纯文件操作。
 *
 * 两件事都要做，缺一不可：
 * 1. `ctx.provide(NAMESPACE, face)` —— 让 typert 的 `service: 'autoReviewPrompts'`
 *    能在 Cordis 里解析到；
 * 2. `ctx.typert.register(TYPERT)` —— 声明这些方法可以被浏览器调用。
 *
 * 任何一步失败都只打 warn：通道坏掉不该影响审查主流程。
 *
 * @param {any} ctx
 * @param {string} dataRoot
 * @param {(message: string) => void} warn
 * @param {Map<string, string>} sessionCwd - 会话 id → cwd 缓存（`pre-execute` 写入）
 */
function mountPromptRemote(ctx, dataRoot, warn, sessionCwd = new Map()) {
  /** 已记录过"首次调用"的会话 id（诊断去重，见 readSessionContext）。 */
  const contextSeen = new Set()
  try {
    // 服务必须无条件提供：typert 注册可能晚于/早于它，但解析发生在调用时。
    //
    // 这里只在**失败**时写探针：成功路径每次调用都记一行会把 probe.log 刷成
    // 噪声，而排查真正需要的恰恰是失败原因。
    const face = {
      async read() {
        try {
          return readAllPrompts(dataRoot)
        } catch (error) {
          probe(ctx, `prompt-remote-call: read-failed ${String(error?.message ?? error)}`)
          throw error
        }
      },
      async writeGlobal(text) {
        try {
          writeGlobalPrompt(dataRoot, text)
          return { ok: true }
        } catch (error) {
          probe(ctx, `prompt-remote-call: writeGlobal-failed ${String(error?.message ?? error)}`)
          throw error
        }
      },
      async writeWorkspace(workspacePath, prompt) {
        try {
          const name = writeWorkspacePrompt(dataRoot, workspacePath, prompt)
          return { ok: true, name }
        } catch (error) {
          probe(ctx, `prompt-remote-call: writeWorkspace-failed ${String(error?.message ?? error)}`)
          throw error
        }
      },
      async removeWorkspace(name) {
        try {
          return { ok: removeWorkspacePrompt(dataRoot, name) }
        } catch (error) {
          probe(ctx, `prompt-remote-call: removeWorkspace-failed ${String(error?.message ?? error)}`)
          throw error
        }
      },
      /**
       * 列出已注册的工作区，供设置页做下拉选择。
       *
       * 直接读宿主的 `workspaceRegistry.list()`（同步投影，按注册顺序）。
       * 拿不到注册表时返回空数组——设置页会退化成手输 + 浏览。
       *
       * @returns {Promise<Array<{ id: string, path: string, title: string }>>}
       */
      async listWorkspaces() {
        try {
          const registry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry
          if (registry === undefined || typeof registry?.list !== 'function') {
            probe(ctx, 'prompt-remote-call: listWorkspaces registry-unavailable')
            return []
          }
          const list = registry.list()
          return (Array.isArray(list) ? list : [])
            .filter((entry) => entry !== null && typeof entry === 'object')
            .map((entry) => ({
              id: String(entry.id ?? ''),
              path: String(entry.path ?? ''),
              title: String(entry.title ?? ''),
            }))
            .filter((entry) => entry.path !== '')
        } catch (error) {
          probe(ctx, `prompt-remote-call: listWorkspaces-failed ${String(error?.message ?? error)}`)
          return []
        }
      },
      /**
       * 读**会话级**提示词。
       *
       * @param {string} sessionId
       * @returns {Promise<{ sessionId: string, prompt: string }>}
       */
      async readSession(sessionId) {
        try {
          return { sessionId: String(sessionId ?? ''), prompt: readSessionPrompt(dataRoot, sessionId) }
        } catch (error) {
          probe(ctx, `prompt-remote-call: readSession-failed ${String(error?.message ?? error)}`)
          throw error
        }
      },
      /**
       * 写**会话级**提示词；空串等于删除该档。
       *
       * @param {string} sessionId
       * @param {string} text
       * @returns {Promise<{ ok: boolean, sessionId: string, removed: boolean }>}
       */
      async writeSession(sessionId, text) {
        try {
          return writeSessionPrompt(dataRoot, sessionId, text)
        } catch (error) {
          probe(ctx, `prompt-remote-call: writeSession-failed ${String(error?.message ?? error)}`)
          throw error
        }
      },
      /**
       * 列出所有会话档（设置页用）。
       *
       * @returns {Promise<Array<{ sessionId: string, prompt: string, bytes: number }>>}
       */
      async listSessions() {
        try {
          return listSessionPrompts(dataRoot)
        } catch (error) {
          probe(ctx, `prompt-remote-call: listSessions-failed ${String(error?.message ?? error)}`)
          return []
        }
      },
      /**
       * 查拒绝记录（工作区 / 会话 / 工具 / 关键字，新的在前）。
       *
       * @param {object} filter
       * @returns {Promise<{ items: Array<any>, total: number, files: string }>}
       */
      async queryDenials(filter) {
        try {
          return queryDenialsFromFile(dataRoot, filter ?? {})
        } catch (error) {
          probe(ctx, `prompt-remote-call: queryDenials-failed ${String(error?.message ?? error)}`)
          throw error
        }
      },
      /**
       * 列出一个会话的上下文：cwd 与该 cwd 命中的工作区档。
       *
       * ## 为什么在 Host 侧算
       *
       * 浏览器半区拿不到会话的 `cwd`（`SessionSnapshot` 不含它，只有
       * `useSession` 的生命周期字段）。`ctx.sessions` / `sessionProjections`
       * 在 Host 侧能直接读，所以这里按 `sessionId` 反查一次。
       *
       * 找不到会话时返回 `{ cwd: null, workspace: null }`——页签会显示
       * "目录未知"而不是崩溃。
       *
       * @param {string} sessionId
       * @returns {Promise<{ sessionId: string, cwd: string | null, workspace: { name: string, path: string } | null }>}
       */
      async readSessionContext(sessionId) {
        const id = String(sessionId ?? '')
        try {
          const resolved = findSessionCwd(ctx, id, sessionCwd)
          const cwd = resolved.cwd
          const workspace = cwd === null ? null : findWorkspaceId(dataRoot, cwd)
          // 诊断：**每个会话首次调用必记一条**，之后只在未命中时记。
          // 目的：能区分"页签根本没调到这里"（通道没就绪）与"调到了但 cwd 为空"。
          const seenKey = `ctx-seen:${id}`
          if (!contextSeen.has(seenKey)) {
            contextSeen.add(seenKey)
            probe(ctx, `readSessionContext: called session=${id} via=${resolved.via} cwd=${cwd ?? 'null'} workspace=${workspace === null ? 'null' : workspace.id}`)
          } else if (cwd === null) {
            probe(ctx, `readSessionContext: cwd-miss session=${id} via=${resolved.via} registry=${resolved.diag.registry} agents=${resolved.diag.agents}`)
          }
          return {
            sessionId: id,
            cwd,
            workspace: workspace === null ? null : { name: workspace.id, path: workspace.path },
          }
        } catch (error) {
          probe(ctx, `prompt-remote-call: readSessionContext-failed ${String(error?.message ?? error)}`)
          return { sessionId: id, cwd: null, workspace: null }
        }
      },
      /**
       * 按**工作区路径**读该工作区档的提示词。
       *
       * 与 `read()` 返回的 `workspaces` 不同：这里只读一个，且按路径而不是
       * 目录名查找，页签拿到的路径可以原样传回来。
       *
       * @param {string} workspacePath
       * @returns {Promise<{ name: string | null, path: string, prompt: string }>}
       */
      async readWorkspacePrompt(workspacePath) {
        try {
          const normalized = String(workspacePath ?? '').trim()
          if (normalized === '') return { name: null, path: '', prompt: '' }
          const name = findWorkspaceDirName(dataRoot, resolve(normalized))
          if (name === null) return { name: null, path: normalized, prompt: '' }
          return { name, path: normalized, prompt: readWorkspacePromptText(dataRoot, normalized) }
        } catch (error) {
          probe(ctx, `prompt-remote-call: readWorkspacePrompt-failed ${String(error?.message ?? error)}`)
          throw error
        }
      },
    }

    // ── 关键：typertRemote 绑定 ────────────────────────────────────────
    //
    // Gateway 在**每次派发**时都会校验它
    // （`dsh-api-gateway/lib/index.js:1450-1462` `validateBinding`）：
    //
    // ```
    // value = Reflect.get(original, 'typertRemote')
    // if (value === undefined) throw 'gateway/binding-invalid'
    // value.service === original && value.serviceKey === key
    // ```
    //
    // 官方写法是继承 `TypertRemoteService`（`dsh-typert-protocol`），它的构造函数
    // 只做两件事：`super(ctx, name)` 以及挂这个绑定。手写可以省掉那个 import——
    // 少一个「包缺失就整插件加载失败」的风险。
    //
    // 已实测（`scripts/_binding-probe.mjs`）：`ctx.provide` 之后 `ctx.get(name)`
    // 返回的就是这个对象本身、且不带 `original` 符号，所以 `originalOf()` 拿到的
    // 是 `face` 自己，绑定成立。
    Object.defineProperty(face, 'typertRemote', {
      value: Object.freeze({
        service: face,
        serviceKey: NAMESPACE,
        namespace: NAMESPACE,
      }),
      enumerable: false,
      writable: false,
      configurable: false,
    })

    ctx.provide(NAMESPACE, face)
    probe(ctx, `prompt-remote: provided ${NAMESPACE}`)
  } catch (error) {
    probe(ctx, `prompt-remote: provide-failed ${String(error?.message ?? error)}`)
    warn(`无法提供 Remote 服务 ${NAMESPACE}（浏览器将无法编辑提示词）：${String(error?.message ?? error)}`)
    return
  }

  try {
    const typert = ctx.get?.('typert')
    if (typert === undefined || typeof typert.register !== 'function') {
      probe(ctx, 'prompt-remote: typert-service-missing')
      warn('宿主没有 typert 服务，提示词文件通道不可用（设置页会回落到只读）')
      return
    }
    ctx.effect(() => {
      try {
        const disposer = typert.register(TYPERT)
        probe(ctx, `prompt-remote: typert-registered ${TYPERT.invocations.length} invocations`)
        return disposer
      } catch (error) {
        probe(ctx, `prompt-remote: typert-register-failed ${String(error?.message ?? error)}`)
        throw error
      }
    }, 'auto-review-custom typert')
  } catch (error) {
    warn(`注册 typert 清单失败（提示词文件通道不可用）：${String(error?.message ?? error)}`)
  }
}

/**
 * 组装**有效配置**读取器。
 *
 * ## 优先级
 *
 * ```
 * Config（profile patch 的 config 块，设置页写的就是它）
 *   ↓ 字段未声明时
 * config.json（旧的用户数据文件）
 *   ↓ 都没有时
 * DEFAULT_CONFIG
 * ```
 *
 * 有了 `Config` 之后，三个开关实际上由设置页接管；`config.json` 只作为
 * 旧数据的兼容回落。
 *
 * @param {any} pluginConfig - `apply` 收到的 `config`（字段是 volatile 引用）。
 * @param {string} dataRoot
 * @param {(message: string) => void} warn
 * @returns {{ read: () => { defaultPreset: string, prompts: boolean, allowRules: boolean, globalPrompt: string, workspacePrompts: Record<string, string> } }}
 */
function makeConfigReader(pluginConfig, dataRoot, warn) {
  const fileReader = createCachedReader(
    join(dataRoot, 'config.json'),
    parseConfig,
    DEFAULT_CONFIG,
    warn,
  )

  const read = () => {
    const file = fileReader.read()
    const preset = readVolatile(pluginConfig?.defaultPreset, file.defaultPreset)
    return {
      defaultPreset: preset === 'auto' ? 'auto' : 'off',
      prompts: readVolatile(pluginConfig?.prompts, file.prompts) !== false,
      allowRules: readVolatile(pluginConfig?.allowRules, file.allowRules) !== false,
      globalPrompt: readVolatile(pluginConfig?.globalPrompt, '') ?? '',
      workspacePrompts: normalizePromptDict(readVolatile(pluginConfig?.workspacePrompts, {})),
    }
  }

  return { read }
}

/**
 * 比对运行时宿主版本与验证过的版本，不一致就**醒目告警**。
 *
 * ## 为什么需要它
 *
 * 本插件的判定全部建立在宿主**内部实现**上（见 VERSIONS.md 的 F1–F11）。
 * 换个宿主版本，最可能的结果不是崩溃，而是**静默失效**——设置页空白、
 * 提示词注不进去、静态放行不生效，全都不报错。用户只会觉得"装了个没用的东西"。
 *
 * 所以装错版本这件事必须**当场说出来**，而不是等人来查。
 *
 * ## 判定口径
 *
 * - **版本不一致** → warn（真问题）
 * - **包解析不到** → 只写探针，不告警（很多是传递依赖，某个 profile 没装很正常）
 *
 * @param {any} ctx
 * @param {(message: string) => void} warn
 */
function warnOnHostMismatch(ctx, warn) {
  try {
    const result = checkHostVersions()

    if (result.status === 'unknown') {
      // 非常规启动方式（拿不到 process.argv[1]）不告警：宁可漏报，也不要误报。
      probe(ctx, 'host-versions: unknown (无法确定运行体版本，跳过比对)')
      return
    }

    if (result.status === 'ok') {
      probe(ctx, `host-versions: ok actual=${result.actual}`)
      return
    }

    probe(ctx, `host-versions: MISMATCH actual=${result.actual} expected=${result.expected}`)
    warn(
      [
        `宿主版本与本插件适配的版本不一致：运行中 ${result.actual}，本插件适配 ${result.expected}。`,
        '本插件的判定依赖宿主的内部实现（见 VERSIONS.md 的 F1–F11），',
        '版本不一致时**可能静默失效**——不报错、就是不工作。',
        '请运行 `node bin/manage.mjs check-compat`；仍不通过请升级本插件。',
      ].join('\n'),
    )
  } catch (error) {
    // 版本检测本身失败不该影响插件：只留痕。
    probe(ctx, `host-versions: check-failed ${String(error?.message ?? error)}`)
  }
}

/** 数据目录名（在 `$DSH_HOME` 下）。 */
const DATA_DIR = 'auto-review'

/**
 * 插件入口。**绝不抛错**——抛错会让 profile 启动失败。
 *
 * @param {any} ctx - Cordis 上下文。
 * @param {any} [pluginConfig] - patch 里的 `config`，字段是 volatile 引用。
 */
export function apply(ctx, pluginConfig) {
  // ── 启动探针：把"apply 是否被执行"写到磁盘，不依赖日志级别 ──────────────
  // 这是排查"装了但没反应"的唯一可靠信号：日志可能被级别过滤，文件不会。
  probe(ctx, 'apply-enter')

  try {
    const dataRoot = resolveDataRoot(ctx)
    const warn = makeLogger(ctx, 'warn')
    const info = makeLogger(ctx, 'info')

    // ── 宿主版本对照：装错版本时当场告警，而不是静默失效 ────────────────
    warnOnHostMismatch(ctx, warn)

    const configReader = makeConfigReader(pluginConfig, dataRoot, warn)

    /**
     * 会话 id → 工作目录缓存。
     *
     * 由 `tools/pre-execute` 写入（那里 `exec.agent.session.header.cwd` 可靠），
     * 供页签的 `readSessionContext` 读取。必须在 `mountPromptRemote` **之前**
     * 建好并传进去，否则 Remote 方法拿不到同一个实例。
     */
    const sessionCwd = new Map()

    // ── Remote 通道：让浏览器读写提示词文件 ──────────────────────────────
    mountPromptRemote(ctx, dataRoot, warn, sessionCwd)

    /** 会话 id ↔ cwd 的短时绑定（审查请求里没有 sessionId，只能旁路带入）。 */
    const sessionBinding = createSessionBinding()

    // ── 门禁：auto review 可用才启动 ─────────────────────────────────────
    //
    // ⚠️ 时序陷阱（2026-10-17 实测踩过）：
    //   auto-review 的 `registerAuto()` 在它自己的 fiber 里执行，依赖
    //   approval / llm / permissionPresets / sessions / tools 五个服务全部就绪。
    //   我们的 ctx.inject(['permissionPresets']) 回调可能**比它先跑**，
    //   此时 names 里还没有 'auto'——一次性判断会永久性地自我禁用。
    //
    // 正确做法：
    //   1. 先立即试一次（通常 auto-review 已就绪）；
    //   2. 没就绪就**订阅 `permission-presets/catalog-changed`**，
    //      registerAuto 内部注册/注销时都会 emit 这个事件（源码
    //      permission-presets/lib/index.js emitCatalogChanged），收到后重试。
    ctx.inject(['permissionPresets'], (child) => {
      /** 一旦启动成功就不再重复挂载。 */
      let started = false

      const tryStart = (trigger) => {
        if (started) return
        try {
          const presets = child.permissionPresets
          const available = Array.isArray(presets?.names) ? presets.names : []
          probe(child, `gate-check(${trigger}) presets=${available.join('|')}`)
          if (!available.includes('auto')) {
            return // 静默等待下一次 catalog-changed，不刷日志
          }
          started = true
          probe(child, `gate-passed(${trigger})`)
          info('检测到 auto 预设可用，插件启动')

          mountDefaultPreset(child, configReader, info, warn)
          mountStaticFileAllow(child, { dataRoot, configReader, warn, sessionBinding, sessionCwd })
          mountReviewInterceptor(child, { dataRoot, configReader, warn, sessionBinding })
        } catch (error) {
          warn(`初始化失败（已跳过，不影响宿主）：${String(error?.message ?? error)}`)
        }
      }

      tryStart('initial')

      if (!started) {
        try {
          child.on('permission-presets/catalog-changed', () => tryStart('catalog-changed'))
          probe(child, 'gate-waiting: subscribed catalog-changed')

          // 诊断用：在 2s / 5s / 10s 各采样一次 names，判定 auto 是"晚到"还是"永不到"。
          // 仅在未启动成功时打点，启动成功后自带 __diagDone 短路。
          const sampleAfter = (ms) => {
            const timer = setTimeout(() => {
              if (started) return
              try {
                const now = child.permissionPresets?.names ?? []
                probe(child, `gate-diag+${ms}ms presets=${now.join('|')}`)
              } catch {
                /* 诊断失败忽略 */
              }
            }, ms)
            // 不阻塞进程退出
            if (typeof timer.unref === 'function') timer.unref()
          }
          sampleAfter(2000)
          sampleAfter(5000)
          sampleAfter(10000)
        } catch (error) {
          probe(child, `gate-subscribe-failed: ${String(error?.message ?? error)}`)
          // 订阅失败时给出明确提示，而不是静默不工作。
          const available = Array.isArray(child.permissionPresets?.names)
            ? child.permissionPresets.names
            : []
          warn(
            `未检测到可用的 auto 预设，且无法订阅 catalog-changed 事件，插件不启动。` +
              `当前可用预设：${available.join(', ') || '无'}。` +
              `请确认 @deepseek-ai/dsh-experimental-auto-review 已在 profile 的 dsh.profile.bundles 中并成功加载。`,
          )
        }
      }
    })

    info(`已装载，适配宿主 ${SUPPORTED_HOST_VERSION}，数据目录 ${dataRoot}`)
    probe(ctx, 'apply-done')
  } catch (error) {
    probe(ctx, `apply-failed: ${String(error?.message ?? error)}`)
    try {
      ctx.logger?.warn?.(`[${name}] 装载异常（已降级）：${String(error?.message ?? error)}`)
    } catch {
      /* 最外层也不抛 */
    }
  }
}

/**
 * 启动探针：把关键事件追加到 `$DSH_HOME/auto-review/probe.log`。
 *
 * 为什么需要它：`info` 日志可能被 exporter 的级别配置过滤掉，
 * 导致"插件明明跑了却看不到任何输出"，排查时无法区分
 * “没加载 / 加载了但门禁挡住 / 加载了但抛错”。写文件不受日志级别影响。
 *
 * 任何失败都静默吞掉——探针绝不能影响插件本身。
 *
 * @param {any} ctx
 * @param {string} event
 */
function probe(ctx, event) {
  try {
    const root = resolveDataRoot(ctx)
    mkdirSync(root, { recursive: true })
    appendFileSync(
      join(root, 'probe.log'),
      `${new Date().toISOString()}\t${event}\tpid=${process.pid}\n`,
      'utf8',
    )
  } catch {
    /* 探针失败绝不影响插件 */
  }
}

/**
 * 造一个永不抛错的日志函数。
 *
 * 使用**命名 logger**（`ctx.logger('auto-review-custom')`），让它与其他插件
 * （`[storage]`、`[llm]` 等）走同一条 exporter 通道。
 * 早期版本用未命名的 `ctx.logger.info()`，在部分 exporter 级别配置下会被静默过滤，
 * 导致"插件明明在跑却看不到任何输出"，排查时极具误导性。
 *
 * @param {any} ctx
 * @param {'info' | 'warn'} level
 * @returns {(message: string) => void}
 */
function makeLogger(ctx, level) {
  return (message) => {
    try {
      const named = typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger
      const fn = named?.[level]
      if (typeof fn === 'function') fn.call(named, message)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
}

/**
 * 解析数据根目录：`$DSH_HOME/auto-review`。
 *
 * @param {any} ctx
 * @returns {string}
 */
function resolveDataRoot(ctx) {
  try {
    const fromService = ctx.get?.('dshHome')
    if (typeof fromService === 'string' && fromService.length > 0) {
      return join(fromService, DATA_DIR)
    }
  } catch {
    /* ctx.get 不存在或有副作用时忽略 */
  }
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) {
    return join(process.env.DSH_HOME, DATA_DIR)
  }
  return join(process.cwd(), '.dsh', DATA_DIR)
}

/**
 * 功能①：新会话建好后自动切到 auto。
 *
 * 三重护栏，缺一不可：
 *   - `defaultPreset === 'auto'`：用户没打开就什么都不做；
 *   - `!state.seeded`：恢复/分叉会话保留它自己的旋钮值；
 *   - `current === defaultPreset`：已经被人手动选过预设的，尊重现状。
 *
 * @param {any} ctx - 已注入 permissionPresets 的子上下文。
 * @param {{ read: () => typeof DEFAULT_CONFIG }} configReader
 * @param {(message: string) => void} info
 * @param {(message: string) => void} warn
 */
function mountDefaultPreset(ctx, configReader, info, warn) {
  ctx.inject(['sessionProjections'], (child) => {
    try {
      child.on('session/created', (session) => {
        try {
          if (configReader.read().defaultPreset !== 'auto') return

          const presets = child.permissionPresets
          if (!presets.names.includes('auto')) return

          const state = child.sessionProjections.stateOf(session, 'permissions')
          if (state?.seeded === true) return
          if (presets.current(session) !== presets.defaultPreset) return

          presets.set(session, 'auto')
          info(`新会话 ${session.id} 已切到 auto 预设`)
        } catch (error) {
          warn(`切换新会话预设失败：${String(error?.message ?? error)}`)
        }
      })
    } catch (error) {
      warn(`注册 session/created 失败：${String(error?.message ?? error)}`)
    }
  })
}

/**
 * 一次审查请求的"改写后重发"标记。
 *
 * 背景：`llm/stream` 是 cordis waterfall，`next()` **不接受参数**；而审查器构造的
 * `options` 又是深度冻结的（实测 `Object.isFrozen(options) === true`），
 * 所以"就地改参再 next()"这条路完全走不通。
 *
 * 可行做法：自己用**新对象**重新调用 `ctx.llm.stream(newOptions)`。但 `stream()`
 * 会重新进入同一个 waterfall，我们的监听器会再次被调用 → 无限递归。
 * 因此用一个 Symbol 标记新请求：看到标记就直接 `next()` 放行，不再处理。
 */
const REPLAY_MARK = Symbol('auto-review-custom.replay')

/**
 * 按工作区绝对路径读它的提示词正文。
 *
 * 与 `readAllPrompts().workspaces` 的区别：那个返回**全部**档（要遍历），
 * 这里只读一个，且按路径定位（页签手里只有路径）。
 *
 * @param {string} dataRoot
 * @param {string} workspacePath
 * @returns {string}
 */
function readWorkspacePromptText(dataRoot, workspacePath) {
  try {
    const name = findWorkspaceDirName(dataRoot, resolve(workspacePath))
    if (name === null) return ''
    const file = join(dataRoot, 'prompts', 'workspace', name, 'note.md')
    if (!existsSync(file)) return ''
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
      .trim()
  } catch {
    return ''
  }
}

/**
 * 功能②：文件类工具的静态放行（在 `tools/pre-execute` 阶段）。
 *
 * 判定与 DSH 沙箱**完全一致**：目标路径在沙箱可写根内就放行。
 * 因为沙箱本来就会允许这个写入，我们只是把这个确定结论提前用于"免审"，
 * 两者不可能冲突——不存在"我们放行但沙箱拒绝"的情况。
 *
 * 命令类工具（`pwsh` 等）在这里**一律不处理**，原样 `next()` 交给 auto review。
 * 这是刻意的：命令的副作用无法静态判定。
 *
 * ## 0.2.0：这里同时是**拒绝记录**与**会话绑定**的唯一挂点
 *
 * 我们是 `prepend: true` 注册的，`await next()` 的返回值就是审查器的最终判决
 * （`{kind:'deny'|'ask', reason, info}`，见 `dsh-tools/lib/index.js:3241-3253`）。
 * 0.1.x 把它直接 `return` 出去了，判决连同理由全部丢弃。
 *
 * 现在分两件事：
 *
 * 1. **记下来**（`denials.jsonl`）：工具、会话、工作区、理由、参数摘要。
 * 2. **绑会话**：审查请求里没有 sessionId，只能在这里把
 *    「这个 cwd 上正在被审的是哪个会话」记进绑定槽，供 `llm/stream` 取用。
 *    绑定必须在 `next()` **之前**做——审查请求是在下游发起的。
 *
 * @param {any} ctx
 * @param {object} deps
 * @param {string} deps.dataRoot
 * @param {{ read: () => typeof DEFAULT_CONFIG }} deps.configReader
 * @param {(message: string) => void} deps.warn
 * @param {{ bind: (cwd: string | undefined, sessionId: unknown) => void }} deps.sessionBinding
 * @param {Map<string, string>} deps.sessionCwd - 会话 id → cwd 缓存（本函数负责写入）
 */
function mountStaticFileAllow(ctx, { dataRoot, configReader, warn, sessionBinding, sessionCwd }) {
  ctx.inject(['tools'], (child) => {
    try {
      child.on(
        'tools/pre-execute',
        async (exec, next) => {
          try {
            // 只处理根调用（PTC 内层调用由审查器负责）。
            if (exec.agent === undefined || exec.parent !== undefined) return await next()

            const cwd = exec.agent.session?.header?.cwd
            const sessionId = exec.agent.session?.id

            // ⚠️ 绑定要在 next() 之前：下游会立刻发起审查请求（llm/stream）。
            sessionBinding.bind(cwd, sessionId)

            // 缓存会话 → cwd，供页签的 readSessionContext 使用。
            //
            // 这是**唯一可靠**的 cwd 来源：`ctx.agents.get(id)` 返回的 Agent
            // 在类型上只有 `{ id }`，没有 `.session`（见 findSessionCwd 注释），
            // 而这里的 `exec.agent.session.header.cwd` 一直是对的。
            if (typeof sessionId === 'string' && sessionId !== '' && typeof cwd === 'string' && cwd !== '') {
              sessionCwd.set(sessionId, cwd)
            }

            if (!configReader.read().allowRules) return await next()

            const verdict = await decide({
              toolName: exec.name,
              args: exec.arguments,
              cwd,
            })

            if (verdict.action === 'allow') {
              probe(child, `static-allow tool=${exec.name} reason=${verdict.reason ?? '-'}`)
              audit(dataRoot, {
                tool: exec.name,
                args: exec.arguments,
                ruleId: 'static-workspace',
                action: 'allow',
              })
              return { kind: 'allow' }
            }

            // 交回下游（auto review），并**记录它给出的结论**。
            const downstream = await next()
            recordVerdict(dataRoot, {
              verdict: downstream,
              tool: exec.name,
              args: exec.arguments,
              cwd,
              sessionId,
              callId: exec.callId,
            })
            return downstream
          } catch (error) {
            warn(`静态放行判定出错（已交回下游）：${String(error?.message ?? error)}`)
            return await next()
          }
        },
        { prepend: true },
      )
    } catch (error) {
      warn(`注册 tools/pre-execute 失败：${String(error?.message ?? error)}`)
    }
  })
}

/**
 * 把下游判决里"不是放行"的那些记进 `denials.jsonl`。
 *
 * 判决形状（`dsh-tools/lib/index.js:3236-3253`）：
 *
 * | kind | 场景 | 记成 |
 * |---|---|---|
 * | `allow` | 审查通过 / 静态放行 | **不记**（放行由 `decisions.jsonl` 管） |
 * | `deny`  | 硬拒绝；审查器失败（fail-closed）也走这里 | `deny` |
 * | `ask`   | 判 deny 但弹给用户裁决 | `ask` |
 * | `cancel`| 会话被中止 | `cancel` |
 *
 * 审查器失败与人工拒绝都会落成 `deny`，靠 `info.code` 区分：
 * `AUTO_REVIEW_DENIED` 是"审查跑完判否"，其它值/缺失表示审查本身出问题。
 *
 * @param {string} dataRoot
 * @param {object} input
 * @param {any} input.verdict
 * @param {string} input.tool
 * @param {unknown} input.args
 * @param {string | undefined} input.cwd
 * @param {string | undefined} input.sessionId
 * @param {unknown} [input.callId]
 */
function recordVerdict(dataRoot, { verdict, tool, args, cwd, sessionId, callId }) {
  try {
    const kind = verdict?.kind
    if (kind !== 'deny' && kind !== 'ask' && kind !== 'cancel') return

    // `deny` 且没有 AUTO_REVIEW_DENIED 码 → 审查器自身失败（fail-closed）。
    const code = typeof verdict?.info?.code === 'string' ? verdict.info.code : null
    const normalized = kind === 'cancel' ? 'fail' : code === null || code === 'AUTO_REVIEW_DENIED' ? kind : 'fail'

    const workspace = findWorkspaceId(dataRoot, cwd)

    appendDenial(dataRoot, {
      kind: normalized,
      tool,
      args,
      reason: typeof verdict?.reason === 'string' ? verdict.reason : null,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      cwd: typeof cwd === 'string' ? cwd : null,
      workspace: workspace === null ? null : workspace.id,
      callId: callId === undefined ? null : String(callId),
      code,
    })
  } catch {
    /* 记录失败绝不影响判决 */
  }
}

/**
 * 功能③：提示词注入（在 `llm/stream` 阶段）。
 *
 * 只做一件事：把「全局 + 工作区 + 会话」提示词塞进审查请求的
 * PROJECT_INSTRUCTIONS 段。放行判定不在这里（见上），这里**永远不吞请求**。
 *
 * @param {any} ctx - 已注入 permissionPresets 的子上下文。
 * @param {object} deps
 * @param {string} deps.dataRoot
 * @param {{ read: () => typeof DEFAULT_CONFIG }} deps.configReader
 * @param {(message: string) => void} deps.warn
 * @param {{ resolve: (cwd: string | undefined) => string | null }} deps.sessionBinding
 */
function mountReviewInterceptor(ctx, { dataRoot, configReader, warn, sessionBinding }) {
  ctx.inject(['llm'], (child) => {
    try {
      probe(child, 'llm-injected: llm/stream listener mounted')
      child.on(
        'llm/stream',
        (options, next) => {
          // 我们自己重发的请求：直接放行，杜绝递归。
          if (options !== null && typeof options === 'object' && options[REPLAY_MARK] === true) {
            return next()
          }

          // 非审查请求：原样透传，一个字节都不碰。
          if (!isReviewRequest(options)) return next()

          probe(child, 'review-request-seen')

          try {
            if (!configReader.read().prompts) return next()

            // options 是深度冻结的，必须构造新对象重发。
            const rewritten = rewrittenOptions(options, dataRoot, sessionBinding)
            if (rewritten === null) {
              probe(child, 'prompt-inject-skipped: no prompt configured')
              return next()
            }
            if (typeof child.llm?.stream !== 'function') {
              probe(child, 'prompt-inject-skipped: llm.stream unavailable')
              warn('无法重新发起审查请求（llm.stream 不可用），提示词未注入')
              return next()
            }

            probe(child, `prompt-injected (replay) scopes=${rewritten.__scopes ?? '-'}`)
            return replayStream(child.llm, rewritten, (message) => probe(child, message))
          } catch (error) {
            warn(`拦截审查请求时出错（已透传原请求）：${String(error?.message ?? error)}`)
            return next()
          }
        },
        { prepend: true },
      )
    } catch (error) {
      warn(`注册 llm/stream 失败：${String(error?.message ?? error)}`)
    }
  })
}

/**
 * 构造一个**带提示词的新 options**，用于重新发起审查请求。
 *
 * 不改动原对象（它是深度冻结的），而是浅拷贝后替换 `messages[0]`。
 *
 * @param {any} options - 原审查请求 options（已冻结，只读）。
 * @param {string} dataRoot
 * @param {{ resolve: (cwd: string | undefined) => string | null }} sessionBinding
 * @returns {any | null} 新 options；没有可注入的提示词时返回 null。
 */
function rewrittenOptions(options, dataRoot, sessionBinding) {
  const message = options.messages[0]
  const text = userMessageText(message)
  if (text === null) return null

  // 从 ENVIRONMENT 段取 cwd，用于匹配工作区档 + 查会话绑定。
  const cwd = cwdOfReviewText(text)
  const sessionId = sessionBinding.resolve(cwd)

  const composed = composePrompts({ root: dataRoot, cwd, sessionId })
  if (composed.text.length === 0) return null

  const result = injectPromptIntoReviewText(text, composed.text)
  if (!result.ok) return null

  const newMessage = {
    ...message,
    content: [{ ...message.content[0], text: result.text }],
  }
  return {
    ...options,
    messages: [newMessage, ...options.messages.slice(1)],
    // 标记：我们的监听器看到它就放行，不再处理，避免无限递归。
    [REPLAY_MARK]: true,
    // 仅用于诊断输出，不传给适配器（replayStream 会剔除）。
    __scopes: composed.parts.map((p) => `${p.scope}:${p.id}`).join(','),
  }
}


/**
 * 追加一条审计记录到 `$DSH_HOME/auto-review/decisions.jsonl`。
 *
 * 只记插件**自己做的决定**（放行/未命中），不记审查器的内容。
 * 参数文本截断到 200 字符并脱敏，避免把密钥写进日志。
 *
 * @param {string} dataRoot
 * @param {{ tool: string, args: unknown, ruleId?: string, action: string }} entry
 */
function audit(dataRoot, entry) {
  try {
    const raw = typeof entry.args === 'object' && entry.args !== null && 'command' in entry.args
      ? String(/** @type {any} */ (entry.args).command)
      : JSON.stringify(entry.args ?? null)
    const masked = raw
      .replace(/(password|passwd|token|secret|apikey|api_key)\s*[=:]\s*\S+/gi, '$1=***')
      .slice(0, 200)
    mkdirSync(dataRoot, { recursive: true })
    appendFileSync(
      join(dataRoot, 'decisions.jsonl'),
      `${JSON.stringify({
        t: new Date().toISOString(),
        tool: entry.tool,
        ruleId: entry.ruleId ?? null,
        action: entry.action,
        arg: masked,
      })}\n`,
      'utf8',
    )
  } catch {
    /* 审计失败绝不影响调用 */
  }
}
