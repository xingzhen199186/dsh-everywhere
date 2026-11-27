/**
 * 同步通道：本地目录 / 网盘目录（P6 第一条通道）。
 *
 * 为什么先做这条：它其实不需要协议——把灵魂包放进一个目录，网盘客户端自己会同步。
 * 代码最少，而"推、拉、比差异"这三件事的逻辑和以后接 Git / S3 是同一套，
 * 先在这里跑通，换传输层就只是换个 copy 实现。
 *
 * 三条从参考实现借来的判断（不是代码）：
 *   1. **先比哈希再动手**：manifest 一致就什么都不做，不做无谓的全量拷贝；
 *   2. **先写内容再写索引**：索引最后落盘，中途断掉时远端只是多一份没人指向的快照，
 *      而不是"索引说有、实际没有"；
 *   3. **保留有限份数**：默认只留最近 5 份，多出来的自动清掉，免得越堆越大。
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { hashFile, hashText, listFilesDeep, toPosix, verifyPack } from './pack.js'

export const SYNC_FORMAT = 'dsh-soul-sync/1'
export const INDEX_FILE = 'index.json'
export const SNAPSHOT_DIR = 'snapshots'
export const DEFAULT_KEEP = 5

/** 包的内容指纹：拿 checksums.json 的哈希当身份。文件一变它就变。 */
export async function packFingerprint(packDir) {
  try {
    return await hashFile(join(packDir, 'integrity/checksums.json'))
  } catch {
    return null
  }
}

/**
 * 用户挑的目录不一定是同步根：在资源管理器里，他看见的是 `snapshots/soul-<时间>` 那一层。
 * 这里负责把"他挑的那层"翻译成"索引所在的那层"。
 *
 * 只认三种形状，别的一律不动：
 *   ① 目录里有 index.json          → 就是它；
 *   ② 目录里有 manifest.json       → 这是一份快照包，根在 `../..`；
 *   ③ 目录名本身叫 snapshots       → 根在上一级。
 */
export async function resolveSyncRoot(dir) {
  const tryFile = async (f) => { try { await stat(f); return true } catch { return false } }
  const has = async (base, name) => tryFile(join(base, name))
  if (await has(dir, INDEX_FILE)) return { root: dir, kind: 'sync', resolved: false }
  if (await has(dir, 'manifest.json')) {
    const up = dirname(dirname(dir))
    if (await has(up, INDEX_FILE)) return { root: up, kind: 'pack', resolved: true }
  }
  if (basename(dir).toLowerCase() === SNAPSHOT_DIR) {
    const up = dirname(dir)
    if (await has(up, INDEX_FILE)) return { root: up, kind: 'snapshots-dir', resolved: true }
  }
  return { root: dir, kind: 'unknown', resolved: false }
}

async function readIndex(targetDir) {
  try {
    const parsed = JSON.parse(await readFile(join(targetDir, INDEX_FILE), 'utf8'))
    if (Array.isArray(parsed?.snapshots)) return parsed
  } catch {
    // 没有索引：第一次推送，或这个目录不是我们建的。
  }
  return { format: SYNC_FORMAT, snapshots: [] }
}

/** 远端有什么：给界面看的一行摘要。 */
export async function inspectTarget(targetDir) {
  const index = await readIndex(targetDir)
  const latest = index.snapshots[0] ?? null
  return {
    ok: true,
    target: toPosix(targetDir),
    format: index.format ?? null,
    count: index.snapshots.length,
    latest,
    snapshots: index.snapshots.map((one) => ({
      id: one.id,
      createdAt: one.createdAt,
      bytes: one.bytes,
      fileCount: one.fileCount,
      profile: one.profile,
      dshVersion: one.dshVersion,
    })),
  }
}

/**
 * 把一份包推到目录里。
 *
 * @returns {Promise<{ok:boolean, skipped?:boolean, id?:string, reason?:string}>}
 */
export async function pushToDir({ packDir, targetDir, keep = DEFAULT_KEEP }) {
  const fingerprint = await packFingerprint(packDir)
  if (!fingerprint) return { ok: false, reason: '这个目录里没有完整的灵魂包（缺 integrity/checksums.json）' }

  const verify = await verifyPack(packDir)
  if (!verify.ok) return { ok: false, reason: `包校验不过，先别推：${verify.problems.slice(0, 2).join('；')}` }

  let manifest
  try {
    manifest = JSON.parse(await readFile(join(packDir, 'manifest.json'), 'utf8'))
  } catch (err) {
    return { ok: false, reason: `读不到 manifest.json（${err?.message ?? err}）` }
  }

  await mkdir(join(targetDir, SNAPSHOT_DIR), { recursive: true })
  const index = await readIndex(targetDir)
  const latest = index.snapshots[0]
  if (latest && latest.fingerprint === fingerprint) {
    return { ok: true, skipped: true, id: latest.id, reason: '远端已经是最新的一份，没有重复推' }
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const id = `soul-${stamp}`
  const dest = join(targetDir, SNAPSHOT_DIR, id)

  // 先写内容：拷完再落索引。顺序反了就会出现"索引说有、实际没有"。
  await rm(dest, { recursive: true, force: true })
  await cp(packDir, dest, { recursive: true })

  index.format = SYNC_FORMAT
  index.snapshots.unshift({
    id,
    createdAt: new Date().toISOString(),
    fingerprint,
    bytes: Number(manifest.bytes) || 0,
    fileCount: Number(manifest.fileCount) || 0,
    profile: manifest?.source?.profile ?? null,
    dshVersion: manifest?.source?.dshVersion ?? null,
  })

  // 只留最近 keep 份；多出来的连目录一起删。
  const dropped = index.snapshots.splice(keep)
  for (const gone of dropped) {
    await rm(join(targetDir, SNAPSHOT_DIR, gone.id), { recursive: true, force: true })
  }
  await writeFile(join(targetDir, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, 'utf8')

  return { ok: true, id, fingerprint, dropped: dropped.map((d) => d.id), bytes: Number(manifest.bytes) || 0 }
}

/**
 * 从目录里拉一份回来。
 *
 * 拉回来落在 `$DSH_HOME/dsh-everywhere/souls/pulled-<id>/`，**不直接覆盖现有包**；
 * 拿到之后照常走 soul_inspect / soul_plan / soul_apply，人还有机会看一眼。
 */
export async function pullFromDir({ targetDir, homeDir, which = '' }) {
  const index = await readIndex(targetDir)
  if (index.snapshots.length === 0) return { ok: false, reason: '这个目录里还没有任何灵魂包' }
  const chosen = which ? index.snapshots.find((one) => one.id === which) : index.snapshots[0]
  if (!chosen) return { ok: false, reason: `目录里没有 id 为 ${which} 的那一份` }

  const src = join(targetDir, SNAPSHOT_DIR, chosen.id)
  try {
    await stat(src)
  } catch {
    return { ok: false, reason: '索引里记着这一份，但目录里找不到（可能被手工删了）' }
  }

  const dest = join(homeDir, 'dsh-everywhere', 'souls', `pulled-${chosen.id}`)
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  await cp(src, dest, { recursive: true })

  const verify = await verifyPack(dest)
  if (!verify.ok) {
    return {
      ok: false,
      dir: toPosix(dest),
      reason:
        `拉下来的包校验不过：${verify.problems.slice(0, 2).join('；')}。`
        + '如果同步目录在 OneDrive / 坚果云里，多半是云端占位文件还没下载到本机：'
        + '在资源管理器里选中该文件夹 → 右键「始终保留在此设备」，等它下完再拉取。',
      problems: verify.problems.slice(0, 5),
    }
  }
  return { ok: true, dir: toPosix(dest), id: chosen.id, bytes: chosen.bytes, fileCount: chosen.fileCount }
}

/**
 * 比差异：本地这份包和远端最新那份是不是同一份。
 *
 * 只比指纹，不传内容——这是"要不要动"的判断，不是同步本身。
 */
export async function compareWithDir({ packDir, targetDir }) {
  const local = await packFingerprint(packDir)
  if (!local) return { ok: false, reason: '本地这个目录不是完整的灵魂包' }
  const index = await readIndex(targetDir)
  const latest = index.snapshots[0]
  if (!latest) return { ok: true, same: false, reason: '远端还没有任何一份' }
  return {
    ok: true,
    same: latest.fingerprint === local,
    remoteId: latest.id,
    remoteCreatedAt: latest.createdAt,
    remoteBytes: latest.bytes,
    reason: latest.fingerprint === local ? '两边是同一份' : '本地这份和远端最新那份不一样',
  }
}

/**
 * 把一份**已经躺在目标目录里**的快照登记进索引（推送一步到位用）。
 *
 * 和 pushToDir 的区别：那边是"本地已有包 → 拷进去"，这里是"包就是在这里建的"，
 * 所以不拷贝，只算指纹、写索引、按保留份数清理。内容与最新一份相同时把刚建的目录删掉。
 */
export async function adoptSnapshot({ targetDir, id, dir, keep = DEFAULT_KEEP }) {
  const fingerprint = await packFingerprint(dir)
  if (!fingerprint) return { ok: false, reason: '刚导出的目录不完整（缺 integrity/checksums.json）' }

  const verify = await verifyPack(dir)
  if (!verify.ok) {
    await rm(dir, { recursive: true, force: true })
    return { ok: false, reason: `导出结果校验不过：${verify.problems.slice(0, 2).join('；')}` }
  }

  let manifest
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    return { ok: false, reason: `读不到 manifest.json（${err?.message ?? err}）` }
  }

  const index = await readIndex(targetDir)
  const latest = index.snapshots[0]
  if (latest && latest.fingerprint === fingerprint) {
    // 和远端最新一份一样：刚建的那份就是垃圾，删掉，别让网盘白传一遍。
    await rm(dir, { recursive: true, force: true })
    return { ok: true, skipped: true, id: latest.id, reason: '远端已经是最新的一份，这次没有重复推' }
  }

  index.format = SYNC_FORMAT
  index.snapshots.unshift({
    id,
    createdAt: new Date().toISOString(),
    fingerprint,
    bytes: Number(manifest.bytes) || 0,
    fileCount: Number(manifest.fileCount) || 0,
    profile: manifest?.source?.profile ?? null,
    dshVersion: manifest?.source?.dshVersion ?? null,
  })
  const dropped = index.snapshots.splice(keep)
  for (const gone of dropped) {
    if (gone.id === id) continue
    await rm(join(targetDir, SNAPSHOT_DIR, gone.id), { recursive: true, force: true })
  }
  await writeFile(join(targetDir, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  return { ok: true, id, fingerprint, bytes: Number(manifest.bytes) || 0, dropped: dropped.map((d) => d.id) }
}

/** 快照 id（同一秒内多次推送要能区分）。 */
export function snapshotId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  return `soul-${stamp}`
}

export { hashText, listFilesDeep }
