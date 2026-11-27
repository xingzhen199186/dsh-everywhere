/**
 * 记忆层：会话历史与附件（P3）。
 *
 * 两条取舍先说清楚：
 *   1. **会话按帧改第一帧的 cwd，其余字节原样搬**——见 session-log.js 的说明。
 *   2. **附件是内容寻址的**（`attachments/v1/objects/<sha 前缀>/<sha>`），路径无关、
 *      天然幂等，直接按对象树复制即可；它和 DSH 版本无关，改了会话格式也不影响它。
 *
 * 版本不同的两端**不搬会话**：会话格式有版本（当前 writer v4），跨版本硬搬只会搬出
 * 读不出来的半截数据。这件事要如实说，不是"差不多就行"。
 */
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { readHeader, projectKeyOf, rewriteHeaderCwd } from './session-log.js'
import { listFilesDeep, toPosix, writeJsonFile } from './pack.js'

/** 导出会话/附件的默认上限：超过就不再往里塞，如实记一条。 */
export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024

/** 一个会话目录里的日志文件（可能是 session.jsonl.zstd 或 session.v4.jsonl.zstd）。 */
function logFileOf(files) {
  return files.find((f) => /session(\.[a-z0-9]+)?\.jsonl\.zstd$/i.test(f)) ?? null
}

/**
 * 列出可导出的会话单元，按最新优先。
 *
 * @returns {Promise<Array<{projectKey:string, sessionId:string, dir:string, files:string[], bytes:number, mtime:number}>>}
 */
export async function listSessionUnits(home) {
  const root = join(home, 'sessions')
  const units = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return units
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    let sessions
    try {
      sessions = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const dir = join(projectDir, session.name)
      const files = await listFilesDeep(dir)
      let bytes = 0
      let mtime = 0
      for (const abs of files) {
        try {
          const info = await stat(abs)
          bytes += info.size
          if (info.mtimeMs > mtime) mtime = info.mtimeMs
        } catch {
          // 单个文件读不到不影响整体判断。
        }
      }
      units.push({
        projectKey: project.name,
        sessionId: session.name,
        dir,
        files: files.map((abs) => toPosix(relative(dir, abs))),
        bytes,
        mtime,
      })
    }
  }
  units.sort((a, b) => b.mtime - a.mtime)
  return units
}

/** 读一个会话的 cwd（从日志第一帧）。读不出来返回 null。 */
export async function readSessionCwd(dir, files) {
  const log = logFileOf(files)
  if (!log) return null
  try {
    const buffer = await readFile(join(dir, log))
    const header = readHeader(buffer)
    return typeof header?.cwd === 'string' ? header.cwd : null
  } catch {
    return null
  }
}

/**
 * 导出会话。
 *
 * @param {object} p
 * @param {string} p.home
 * @param {string} p.outDir 灵魂包根目录
 * @param {'none'|'recent'|'all'} [p.mode]
 * @param {number} [p.limit] recent 模式带多少个
 * @param {number} [p.maxBytes]
 */
export async function exportSessions({ home, outDir, mode = 'none', limit = 20, maxBytes = DEFAULT_MAX_BYTES }) {
  if (mode === 'none') return { ok: true, sessions: [], bytes: 0, notes: [] }
  const notes = []
  const all = await listSessionUnits(home)
  const wanted = mode === 'recent' ? all.slice(0, Math.max(1, limit)) : all
  const sessions = []
  let bytes = 0
  for (const unit of wanted) {
    if (bytes + unit.bytes > maxBytes) {
      notes.push(`会话累计超过上限（${Math.round(maxBytes / 1024 / 1024)} MB），后面的没有带走`)
      break
    }
    const cwd = await readSessionCwd(unit.dir, unit.files)
    if (cwd === null) notes.push(`会话 ${unit.sessionId} 读不出 cwd，仍会带走（导入时无法改写路径）`)
    const relDir = `sessions/${unit.projectKey}/${unit.sessionId}`
    for (const file of unit.files) {
      const src = join(unit.dir, file)
      const dest = join(outDir, relDir, file)
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(src, dest)
    }
    sessions.push({
      projectKey: unit.projectKey,
      sessionId: unit.sessionId,
      cwd,
      files: unit.files,
      bytes: unit.bytes,
    })
    bytes += unit.bytes
  }
  await writeJsonFile(outDir, 'sessions/index.json', {
    exportedAt: new Date().toISOString(),
    mode,
    count: sessions.length,
    bytes,
    sessions,
  })
  return { ok: true, sessions, bytes, notes }
}

/**
 * 导出附件。内容寻址，直接整棵对象树复制。
 */
export async function exportAttachments({ home, outDir, maxBytes = DEFAULT_MAX_BYTES }) {
  const root = join(home, 'attachments')
  const files = await listFilesDeep(root)
  const notes = []
  let bytes = 0
  let copied = 0
  for (const abs of files) {
    const rel = toPosix(relative(root, abs))
    const info = await stat(abs)
    if (bytes + info.size > maxBytes) {
      notes.push(`附件累计超过上限（${Math.round(maxBytes / 1024 / 1024)} MB），后面的没有带走`)
      break
    }
    const dest = join(outDir, 'attachments', rel)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(abs, dest)
    bytes += info.size
    copied += 1
  }
  return { ok: true, objects: copied, bytes, notes, available: files.length }
}

/** 读包里的会话索引。没有就返回 null（"没带会话"和"索引坏了"要分得开）。 */
export async function readSessionIndex(packDir) {
  try {
    const parsed = JSON.parse(await readFile(join(packDir, 'sessions/index.json'), 'utf8'))
    return Array.isArray(parsed?.sessions) ? parsed : null
  } catch {
    return null
  }
}

/** 包里有哪些附件对象（相对 `attachments/` 的路径）。 */
export async function listPackAttachments(packDir) {
  const files = await listFilesDeep(join(packDir, 'attachments'))
  return files.map((abs) => toPosix(relative(join(packDir, 'attachments'), abs)))
}

/**
 * 路径映射：按顺序、按段边界、先规范化分隔符。
 *
 * 段边界的意思是 `I:\极简遥控器` 不能命中 `I:\极简遥控器2`——少一个字符就是另一个目录。
 */
export function applyPathMap(cwd, maps = []) {
  if (typeof cwd !== 'string' || !cwd) return cwd
  const normalized = cwd.replace(/\\/g, '/')
  for (const map of maps) {
    const from = String(map?.oldPrefix ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    const to = String(map?.newPrefix ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (!from || !to) continue
    const lowerNormalized = normalized.toLowerCase()
    const lowerFrom = from.toLowerCase()
    if (lowerNormalized === lowerFrom) return to
    if (lowerNormalized.startsWith(`${lowerFrom}/`)) return to + normalized.slice(from.length)
  }
  return cwd
}

/**
 * 把一个会话写进目标机。
 *
 * @returns {Promise<{ok:boolean, added:string[], mapped:string, reason?:string}>}
 */
export async function writeSession({ packDir, home, entry, maps = [] }) {
  const added = []
  const original = typeof entry.cwd === 'string' ? entry.cwd : null
  const mapped = original ? applyPathMap(original, maps) : null
  const key = (mapped && projectKeyOf(mapped)) || entry.projectKey
  const destDir = join(home, 'sessions', key, entry.sessionId)

  // 已有同 id 的会话：**绝不覆盖**。用户自己那条比包里那条更要紧。
  try {
    await stat(destDir)
    return { ok: false, reason: '目标机已有同 id 的会话，跳过（不覆盖）', added, mapped }
  } catch {
    // 不存在，继续。
  }

  const sourceDir = join(packDir, 'sessions', entry.projectKey, entry.sessionId)
  const files = Array.isArray(entry.files) && entry.files.length > 0 ? entry.files : await listFilesDeep(sourceDir).then(
    (list) => list.map((abs) => toPosix(relative(sourceDir, abs))),
  )
  const log = logFileOf(files)

  for (const file of files) {
    const src = join(sourceDir, file)
    const dest = join(destDir, file)
    await mkdir(dirname(dest), { recursive: true })
    if (log && file === log && mapped && mapped !== original) {
      // 只换第一帧，其余帧原样拼回去；改不动就整份照抄，绝不写半截。
      const buffer = await readFile(src)
      const rewritten = rewriteHeaderCwd(buffer, mapped)
      if (rewritten.ok && rewritten.buffer) {
        await writeFile(dest, rewritten.buffer)
      } else {
        await copyFile(src, dest)
        return {
          ok: false,
          reason: `路径改写失败（${rewritten.reason}），已原样复制但没有改 cwd`,
          added: [...added, dest],
          mapped,
        }
      }
    } else {
      await copyFile(src, dest)
    }
    added.push(dest)
  }
  return { ok: true, added, mapped: mapped ?? original ?? '' }
}

/** 把包里的附件复制到目标机：只补缺的（内容寻址，天然幂等）。 */
export async function writeAttachments({ packDir, home }) {
  const rels = await listPackAttachments(packDir)
  const added = []
  let skipped = 0
  for (const rel of rels) {
    const dest = join(home, 'attachments', rel)
    try {
      const existing = await stat(dest)
      if (existing.isFile()) {
        skipped += 1
        continue
      }
    } catch {
      // 缺，继续复制。
    }
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(join(packDir, 'attachments', rel), dest)
    added.push(dest)
  }
  return { ok: true, added, skipped, total: rels.length }
}

/** 这个目录里有几个文件（批次账目用）。 */
export async function countFilesDeep(dir) {
  return (await listFilesDeep(dir)).length
}

// 兼容：有些调用点只想读一个流。
export function openReadStream(abs) {
  return createReadStream(abs)
}
