/**
 * 灵魂包的读写：一个目录 + `manifest.json` + `integrity/checksums.json`。
 *
 * 为什么是目录不是 zip：会话和附件合起来是几个 GB，目录便于挑选、续传、人工核对；
 * 单文件只是"好拷贝"这一种场合的便利，不是必需。
 *
 * 为什么每个文件都记 sha256：导入前要能回答"这份包有没有被改过、有没有拷坏"。
 * 没有这层，读到一个半截的 settings 就可能写进配置里。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/** 包格式版本。结构变了就加一，导入端据此判断能不能读。 */
export const PACK_FORMAT = 'dsh-soul/1'

export const MANIFEST = 'manifest.json'
export const CHECKSUMS = 'integrity/checksums.json'

/** 流式算 sha256：包里的文件可能几十 MB，不整份读进内存。 */
export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

export function hashText(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** 包内相对路径统一用 `/`，跨平台比较才不会一边 `\` 一边 `/`。 */
export function toPosix(value) {
  return value.split(sep).join('/')
}

/** 写一个 JSON 文件（父目录自动建），返回它的包内相对路径。 */
export async function writeJsonFile(root, rel, value) {
  const abs = join(root, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return toPosix(rel)
}

/** 写一段文本，返回包内相对路径。 */
export async function writeTextFile(root, rel, text) {
  const abs = join(root, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, text, 'utf8')
  return toPosix(rel)
}

/** 把外部文件复制进包，返回包内相对路径。源不存在时返回 null（调用方决定要不要记一条）。 */
export async function copyInto(root, rel, srcAbs) {
  try {
    const info = await stat(srcAbs)
    if (!info.isFile()) return null
  } catch {
    return null
  }
  const abs = join(root, rel)
  await mkdir(dirname(abs), { recursive: true })
  await cp(srcAbs, abs)
  return toPosix(rel)
}

/** 递归列出目录下所有文件（相对路径，posix 分隔）。目录不存在返回空数组。 */
export async function listFilesDeep(dir) {
  const out = []
  async function walk(current) {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(current, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile()) out.push(abs)
    }
  }
  await walk(dir)
  return out
}

/**
 * 收尾：给已写进包的所有内容算校验和，再把 manifest 落盘。
 *
 * 顺序讲究——先算 checksums 再写 manifest，这样 manifest 自己不在清单里也不会
 * 造成"改了 manifest 却验不出来"。导入端会单独核对 manifest 的 format 字段。
 */
export async function finalizePack(root, manifest) {
  const files = await listFilesDeep(root)
  const checksums = {}
  let bytes = 0
  for (const abs of files.sort()) {
    const rel = toPosix(relative(root, abs))
    if (rel === CHECKSUMS || rel === MANIFEST) continue
    const info = await stat(abs)
    bytes += info.size
    checksums[rel] = await hashFile(abs)
  }
  await writeJsonFile(root, CHECKSUMS, { algorithm: 'sha256', files: checksums })
  const full = { ...manifest, format: PACK_FORMAT, bytes, fileCount: Object.keys(checksums).length }
  await writeJsonFile(root, MANIFEST, full)
  return full
}

/** 读 manifest。读不到或者格式不认识都返回 `{ok:false}`，不抛。 */
export async function readManifest(root) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(root, MANIFEST), 'utf8'))
  } catch (err) {
    return { ok: false, error: `读不到 manifest.json（${err?.message ?? err}）` }
  }
  if (!manifest || typeof manifest !== 'object') return { ok: false, error: 'manifest.json 不是对象' }
  if (typeof manifest.format !== 'string' || !manifest.format.startsWith('dsh-soul/')) {
    return { ok: false, error: `这不是移魂包（format=${String(manifest.format)}）` }
  }
  if (manifest.format !== PACK_FORMAT) {
    return { ok: false, error: `包格式 ${manifest.format} 与当前版本 ${PACK_FORMAT} 不一致` }
  }
  return { ok: true, manifest }
}

/**
 * 逐文件校验。
 *
 * 判定口径：**清单里有、盘上没有**＝缺件（硬失败）；**盘上有、清单里没有**＝多出来的
 * 文件（只提示，不当失败，因为用户可能往包里塞了说明文档）；**哈希对不上**＝被改过（硬失败）。
 */
export async function verifyPack(root) {
  const problems = []
  const extra = []
  let checksums
  try {
    const parsed = JSON.parse(await readFile(join(root, CHECKSUMS), 'utf8'))
    checksums = parsed?.files && typeof parsed.files === 'object' ? parsed.files : null
  } catch (err) {
    return { ok: false, problems: [`读不到 integrity/checksums.json（${err?.message ?? err}）`], extra }
  }
  if (!checksums) return { ok: false, problems: ['checksums.json 里没有 files 表'], extra }
  for (const [rel, expected] of Object.entries(checksums)) {
    const abs = join(root, rel)
    let actual
    try {
      actual = await hashFile(abs)
    } catch {
      problems.push(`缺件：${rel}`)
      continue
    }
    if (actual !== expected) problems.push(`内容被改动过：${rel}`)
  }
  const known = new Set(Object.keys(checksums))
  for (const abs of await listFilesDeep(root)) {
    const rel = toPosix(relative(root, abs))
    if (rel === MANIFEST || rel === CHECKSUMS) continue
    if (!known.has(rel)) extra.push(rel)
  }
  return { ok: problems.length === 0, problems, extra }
}
