/**
 * 面板选项的"记住"（P6 附带）。
 *
 * 用户的意思很直接：导出的选项、目标目录这些，下次打开不该再设一遍。
 * 存的是**选项**，不存密码——密码只在一次调用的内存里过，落盘就违背了凭据那一层的初衷。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const PREFS_FILE = 'souls/prefs.json'

/** 只认这几项：多出来的键一律忽略，免得把别人的状态写进我们的文件。 */
const ALLOWED = ['sessions', 'sessionLimit', 'attachments', 'pluginData', 'syncDir', 'keep', 'profile']

export function prefsPath(home) {
  return join(home, 'dsh-everywhere', PREFS_FILE)
}

export async function readPrefs(home) {
  try {
    const parsed = JSON.parse(await readFile(prefsPath(home), 'utf8'))
    const out = {}
    for (const key of ALLOWED) {
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, key)) out[key] = parsed[key]
    }
    return out
  } catch {
    return {}
  }
}

/** 合并保存：只更新传进来的那几项，其余保持原样。 */
export async function writePrefs(home, patch) {
  const current = await readPrefs(home)
  const next = { ...current }
  for (const key of ALLOWED) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key]
  }
  const file = prefsPath(home)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}
