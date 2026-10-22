/**
 * Remote 通道：让浏览器能通过 Host 读写提示词文件。
 *
 * ## 为什么需要它
 *
 * 浏览器半区没有文件系统（能用的只有 `ctx` / `React` / `styles` / `console`）。
 * 而提示词是长文本，不适合塞进 `cordis.patch.yml`。所以由 Host 半区提供一组
 * Remote 方法，浏览器调它来读写 `$DSH_HOME/auto-review/prompts/**`。
 *
 * ## 机制（全部来自源码，不是猜的）
 *
 * - **Host 侧**：`ctx.typert.register(TYPERT)` 注册调用描述符。宿主注释明确说
 *   手动注册是受支持的路径（`dsh-typert-loader/lib/index.js:27-29`）。
 * - **Client 侧**：`await ctx.remote.$mount(TYPERT_REMOTE)` 在运行时挂载
 *   （`TypertClientRemote.$mount`；用例见
 *   `dsh-experimental-client-ui-voice-input/lib/client.js:5818`）。
 * - **编解码约束**：`dsh-api-gateway` 的 `requireStrictInputs`
 *   （`lib/client.js:2067-2075`）要求**每个参数** `codec.mode === 'strict'`；
 *   `src-json` 只能用在 result 上。所以下面的参数全部带真正的 zod schema。
 *
 * @module dsh-auto-review-custom/typert
 */

import { z } from 'zod'

/** 本包的 npm 名；manifest 的 `package` 必须与它一致。 */
const PACKAGE = 'dsh-auto-review-custom'

/** Remote 命名空间；客户端拿到的是 `ctx.remote.autoReviewPrompts`。 */
export const NAMESPACE = 'autoReviewPrompts'

/** Host 侧服务键；在 `apply` 里由 `ctx.provide(NAMESPACE, face)` 提供。 */
export const SERVICE = NAMESPACE

/** result 用保守码：任意 JSON，不需要 schema。 */
const JSON_RESULT = Object.freeze({ mode: 'src-json' })

/**
 * 造一个 strict 字符串参数描述符。
 *
 * `create` 返回 zod schema，宿主解码入参时用得到。
 *
 * @param {string} name
 * @param {number} index - 参数序号，用于生成稳定的 typeSymbol。
 * @param {string} method
 */
function stringParam(name, index, method) {
  return {
    name,
    wire: name,
    source: 'json',
    codec: {
      mode: 'strict',
      typeSymbol: `${PACKAGE}#${NAMESPACE}/${method}:parameter:${index}`,
      create: () => z.string(),
    },
  }
}

/** 造一条调用描述符。 */
function invocation(method, parameterNames) {
  return {
    id: `${PACKAGE}#${NAMESPACE}/${method}`,
    service: SERVICE,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameterNames.map((name, index) => stringParam(name, index, method)),
    result: JSON_RESULT,
  }
}

/**
 * Host 侧注册清单。
 *
 * `model` 是给 API 目录/文档用的反射信息；运行时不靠它分发，但注册会校验形状。
 */
export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: [
    invocation('read', []),
    invocation('writeGlobal', ['text']),
    invocation('writeWorkspace', ['workspacePath', 'prompt']),
    invocation('removeWorkspace', ['name']),
    invocation('listWorkspaces', []),
  ],
  model: {
    services: [
      {
        description: 'Reads and writes the Auto review prompt files on the Host.',
        summary: 'Reads and writes the Auto review prompt files on the Host.',
        tags: [],
        jsDoc:
          '/** Read and write the Auto review prompt files stored under $DSH_HOME/auto-review/prompts. */',
        key: SERVICE,
        exportName: 'default',
        members: [
          {
            kind: 'method',
            name: 'read',
            signature:
              'async read(): Promise<{ global: string; workspaces: Array<{ name: string; path: string; prompt: string }> }>',
            summary: 'Read the global prompt and every workspace prompt.',
            jsDoc: '/** @returns the global prompt and every workspace prompt file. */',
          },
          {
            kind: 'method',
            name: 'writeGlobal',
            signature: 'async writeGlobal(text: string): Promise<{ ok: boolean }>',
            summary: 'Replace the global prompt; an empty string removes the file.',
            jsDoc: '/** @param text - the new prompt; empty removes the file. */',
          },
          {
            kind: 'method',
            name: 'writeWorkspace',
            signature:
              'async writeWorkspace(workspacePath: string, prompt: string): Promise<{ ok: boolean; name?: string }>',
            summary: 'Create or replace one workspace prompt; an empty prompt removes it.',
            jsDoc:
              '/** @param workspacePath - absolute workspace directory. @param prompt - the new prompt; empty removes the file. */',
          },
          {
            kind: 'method',
            name: 'removeWorkspace',
            signature: 'async removeWorkspace(name: string): Promise<{ ok: boolean }>',
            summary: 'Remove one workspace prompt by its directory name.',
            jsDoc: '/** @param name - the workspace prompt directory name. */',
          },
          {
            kind: 'method',
            name: 'listWorkspaces',
            signature:
              'async listWorkspaces(): Promise<Array<{ id: string; path: string; title: string }>>',
            summary:
              'List the registered Host workspaces so the setter can offer real paths instead of typing.',
            jsDoc:
              '/** @returns every registered workspace as { id, path, title }, in registry order. */',
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}

/** Client 侧挂载清单；描述符与 Host 的 invocations 一一对应。 */
export const TYPERT_REMOTE = {
  package: PACKAGE,
  descriptors: TYPERT.invocations,
}
