/**
 * 插件私有数据：发现、导出、写回（P5）。
 *
 * 白名单表照搬自参考实现（见 `plugin-data-registry.js` 顶部的出处说明）。
 * 这一层是**薄的**：发现有哪些区域、哪些要排除、复制进包、再复制回去。
 * 参考实现里那套 adapter 框架绑在它自己的引擎上，我们不需要，也不搬。
 *
 * 三条口径跟参考实现一致：
 *   1. `role: 'cache'` 的目录**不收**——缓存是可再生产物，带了只是浪费体积；
 *   2. 区域里 `excludeRel` 列出的子路径**不收**（先折成区域相对再比，见 isExcludedRel）；
 *   3. 声明形状不合法**整条跳过**，绝不"尽力而为"拼一个路径出来。
 */
import { readdir, readFile, stat, mkdir, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { listFilesDeep, toPosix, writeJsonFile } from './pack.js'
import {
  BUILTIN_PLUGIN_DATA_SOURCES,
  isExcludedRel,
  normalizeHomeRel,
  parseDeclaredDataDirs,
  sectionOfRole,
} from './plugin-data-registry.js'

/** 单个区域默认上限。超过就不带，如实说。 */
export const MAX_AREA_BYTES = 512 * 1024 * 1024

/**
 * 扫出这台机器上"值得带走"的私有数据区域。
 *
 * 两条来源：内置表（只收本 profile 真装了的那些包）+ 各插件在 `package.json` 里的
 * `dsh.dataDirs` 声明（本机目前一个都没有，但机制留着：将来有插件声明就自动进来）。
 *
 * @returns {Promise<Array<{id:string, relPath:string, role:string, excludeRel:string[], source:string, exists:boolean}>>}
 */
export async function discoverPluginDataAreas({ profile, profileDir, homeDir = homedir() }) {
  const sources = []

  // 内置表：只留"这个 profile 里确实装着它"的来源，免得带一堆不存在的目录。
  const installed = await installedPackages(profileDir)
  for (const source of BUILTIN_PLUGIN_DATA_SOURCES) {
    const hit = (source.packages || []).some((name) => installed.has(name))
    if (hit) sources.push(source)
  }

  // 插件自述：读 profile 实际安装的那份 manifest（不同档案可能是不同版本）。
  for (const name of installed) {
    try {
      const manifest = JSON.parse(await readFile(join(profileDir, 'node_modules', name, 'package.json'), 'utf8'))
      const declared = parseDeclaredDataDirs(name, manifest)
      if (declared) sources.push(declared)
    } catch {
      // 读不到 = 没声明，跳过。
    }
  }

  const home = homeDir
  const areas = []
  for (const source of sources) {
    for (const area of source.areas || []) {
      if (!sectionOfRole(area.role)) continue // cache 不要
      const relPath = normalizeHomeRel(area.relPath)
      if (!relPath) continue
      let exists = false
      try {
        exists = (await stat(join(home, relPath))).isDirectory()
      } catch {
        exists = false
      }
      if (!exists) continue
      areas.push({
        id: source.id,
        relPath,
        role: area.role,
        excludeRel: Array.isArray(area.excludeRel) ? area.excludeRel : [],
        source: source.evidence ? `${source.evidence}` : 'declared',
        exists,
      })
    }
  }
  return areas
}

/** profile 里装了哪些包（依赖清单里列出的那些）。 */
async function installedPackages(profileDir) {
  const out = new Set()
  try {
    const pkg = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    for (const name of Object.keys(pkg?.dependencies || {})) out.add(name)
  } catch {
    // 读不到依赖清单就当没装。
  }
  return out
}

/**
 * 把私有数据复制进灵魂包。
 *
 * @returns {Promise<{ok:boolean, areas:Array, bytes:number, notes:string[]}>}
 */
export async function exportPluginData({ areas, outDir, homeDir = homedir(), maxAreaBytes = MAX_AREA_BYTES }) {
  const home = homeDir
  const notes = []
  const written = []
  let bytes = 0

  for (const area of areas) {
    const root = join(home, area.relPath)
    const files = await listFilesDeep(root)
    let areaBytes = 0
    const copied = []
    for (const abs of files) {
      const rel = toPosix(abs.slice(root.length + 1))
      const homeRel = `${area.relPath}/${rel}`
      if (isExcludedRel(area, homeRel)) continue
      const info = await stat(abs)
      if (areaBytes + info.size > maxAreaBytes) {
        notes.push(`${area.relPath} 超过单区上限（${Math.round(maxAreaBytes / 1024 / 1024)} MB），后面的没有带走`)
        break
      }
      const dest = join(outDir, 'plugin-data', area.relPath, rel)
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(abs, dest)
      areaBytes += info.size
      copied.push(rel)
    }
    if (copied.length === 0) continue
    written.push({ ...area, files: copied.length, bytes: areaBytes })
    bytes += areaBytes
  }

  if (written.length > 0) {
    await writeJsonFile(outDir, 'plugin-data/index.json', {
      exportedAt: new Date().toISOString(),
      root: 'home',
      note: '这些目录相对**用户主目录**，不是 $DSH_HOME。导入时按同一路径写回。',
      areas: written.map((a) => ({ id: a.id, relPath: a.relPath, role: a.role, files: a.files, bytes: a.bytes })),
    })
  }
  return { ok: true, areas: written, bytes, notes }
}

/** 读包里的私有数据清单。 */
export async function readPluginDataIndex(packDir) {
  try {
    const parsed = JSON.parse(await readFile(join(packDir, 'plugin-data/index.json'), 'utf8'))
    return Array.isArray(parsed?.areas) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 把私有数据写回本机。
 *
 * **已存在的文件不覆盖**：私有数据里可能有用户后改的东西（比如记忆库），
 * 拿旧的盖新的比少带一点更糟。
 */
export async function applyPluginData({ packDir, homeDir = homedir() }) {
  const home = homeDir
  const root = join(packDir, 'plugin-data')
  const files = await listFilesDeep(root)
  const added = []
  let skipped = 0
  for (const abs of files) {
    const rel = toPosix(abs.slice(root.length + 1))
    if (rel === 'index.json') continue
    const dest = join(home, rel)
    try {
      const info = await stat(dest)
      if (info.isFile()) {
        skipped += 1
        continue
      }
    } catch {
      // 缺就复制。
    }
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(abs, dest)
    added.push(dest)
  }
  return { ok: true, added, skipped, total: files.length }
}

/** 包里带了几个区域（体检用）。 */
export async function listPackPluginDataAreas(packDir) {
  const index = await readPluginDataIndex(packDir)
  if (!index) return []
  return index.areas || []
}

// 让调用方少 import 一个模块：列目录的工具这里也导出。
export { listFilesDeep }
