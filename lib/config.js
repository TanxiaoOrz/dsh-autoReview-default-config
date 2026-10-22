/**
 * 配置的加载（带 mtime 热更新缓存）。
 *
 * 设计要点：
 *   - **解析失败保留上一版**，绝不因为写坏一个 JSON 就把审查提示词全丢掉；
 *   - 从未成功加载过 → 视为默认配置（fail-closed：什么都不改，全交回原审查）；
 *   - 用 `statSync().mtimeMs` 判断是否重读，不用 `fs.watch`
 *     （Windows 上 watch 语义不稳，且会给插件留下悬空的监听器）。
 *
 * @module dsh-auto-review-custom/config
 */

import { existsSync, readFileSync, statSync } from 'node:fs'

/** 配置默认值：下列开关的语义见各项注释。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 新会话建好后是否自动切到 auto 预设。 */
  defaultPreset: 'off', // 'auto' | 'off'
  /** 是否把「全局 + 工作区」提示词注入审查请求的 PROJECT_INSTRUCTIONS 段。 */
  prompts: true,
  /**
   * 是否对**文件类工具**（read/write/edit）做静态放行。
   *
   * 语义：目标路径在沙箱可写根内（会话 cwd / `/tmp` / `os.tmpdir()`）就直接
   * 放行、不进审查。**不是**正则白名单，命令类工具永远不受此开关影响。
   */
  allowRules: true,
})

/**
 * 建一个带 mtime 缓存的文件读取器。
 *
 * @template T
 * @param {string} path - 文件绝对路径。
 * @param {(raw: string) => T} parse - 解析函数；抛错时保留上一版。
 * @param {T} empty - 从未成功加载过时返回的值。
 * @param {(message: string) => void} warn - 告警回调。
 * @returns {{ read: () => T, path: string }}
 */
export function createCachedReader(path, parse, empty, warn) {
  let lastMtime = -1
  let current = empty
  let everLoaded = false

  const read = () => {
    let mtime
    try {
      if (!existsSync(path)) {
        if (lastMtime !== -2) {
          lastMtime = -2
          current = empty
          everLoaded = false
        }
        return current
      }
      mtime = statSync(path).mtimeMs
    } catch (error) {
      warn(`无法读取 ${path}：${String(error?.message ?? error)}`)
      return current
    }
    if (mtime === lastMtime) return current
    lastMtime = mtime

    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      warn(`无法读取 ${path}：${String(error?.message ?? error)}`)
      return current
    }

    try {
      current = parse(raw)
      everLoaded = true
    } catch (error) {
      // 保留上一版；从未成功过则继续用 empty。
      warn(`${path} 解析失败，沿用${everLoaded ? '上一版有效配置' : '空配置'}：${String(error?.message ?? error)}`)
    }
    return current
  }

  return { read, path }
}

/**
 * 解析 config.json。
 *
 * @param {string} raw
 * @returns {typeof DEFAULT_CONFIG}
 */
export function parseConfig(raw) {
  const value = raw.trim() === '' ? {} : JSON.parse(raw)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config.json 顶层必须是对象')
  }
  const record = /** @type {Record<string, unknown>} */ (value)
  const defaultPreset = record.defaultPreset === 'auto' ? 'auto' : 'off'
  return {
    defaultPreset,
    prompts: record.prompts !== false,
    // 文件类工具静态放行开关（不是正则白名单）。
    allowRules: record.allowRules !== false,
  }
}
