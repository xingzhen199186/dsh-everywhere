/**
 * 本地源插件的打包（`link:` / `file:` 来源）。
 *
 * 为什么必须单独处理：这类插件在源机器上指向**一个本机路径**，搬走以后那条路径在
 * 目标机上必然不存在——不打包的话，目标机装出来的东西是"名字对、内容不对"，或者干脆
 * 装不上。所以导出时要把源码目录打成 tarball 放进包里，导入时再改写成 `file:<绝对路径>`。
 *
 * 用 `npm pack` 而不是自己压缩：它本来就排除 `node_modules`、遵守 `files` 白名单、
 * 产出和 registry 上同构的包，官方安装通道才认。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { copyInto, toPosix } from './pack.js'

const run = promisify(execFile)

/** 单个本地插件的体积上限。和 tarball 上传的上限保持一致，超过就不带、只提示。 */
export const MAX_LOCAL_BYTES = 100 * 1024 * 1024

/** 这个 spec 是不是本地来源。 */
export function isLocalSpec(spec) {
  if (typeof spec !== 'string' || !spec) return false
  if (spec.startsWith('link:') || spec.startsWith('file:')) return true
  // 裸路径（绝对或相对）也算本地来源；`name@1.0.0` 这类注册表 spec 不算。
  if (/^[a-zA-Z]:[\\/]/.test(spec)) return true
  if (spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../')) return true
  return false
}

/** 把 spec 变成本机路径。 */
export function specToPath(spec, home) {
  const raw = spec.replace(/^(link:|file:)/, '')
  return isAbsolute(raw) ? raw : resolve(home, raw)
}

/**
 * 打一个本地插件。
 *
 * @param {object} p
 * @param {string} p.name 包名
 * @param {string} p.spec `link:` / `file:` / 裸路径
 * @param {string} p.home 源机器的 home（相对路径按它解析）
 * @param {string} p.outRoot 灵魂包根目录
 * @param {Function} [p.runPack] 注入点：测试用来替换真实 `npm pack`
 * @returns {Promise<{ok:boolean, rel?:string, bytes?:number, source?:string, reason?:string}>}
 */
export async function packLocalPlugin({ name, spec, home, outRoot, runPack }) {
  const source = specToPath(spec, home)
  let info
  try {
    info = await stat(source)
  } catch {
    return { ok: false, reason: `源路径不存在：${toPosix(source)}` }
  }

  // `file:` 已经指向一个 tarball：不必再打一次，直接搬进去。
  if (info.isFile() && /\.(tgz|tar\.gz)$/i.test(source)) {
    if (info.size > MAX_LOCAL_BYTES) {
      return { ok: false, reason: `超过上限（${Math.round(info.size / 1024 / 1024)} MB > 100 MB）` }
    }
    const rel = `plugins/local/${sanitize(name)}.tgz`
    if (!(await copyInto(outRoot, rel, source))) return { ok: false, reason: '复制 tarball 失败' }
    return { ok: true, rel, bytes: info.size, source: toPosix(source) }
  }

  if (!info.isDirectory()) {
    return { ok: false, reason: `${toPosix(source)} 既不是目录也不是 .tgz` }
  }

  const staging = join(outRoot, 'plugins', 'local')
  await mkdir(staging, { recursive: true })
  const packer = runPack || defaultPack
  let produced
  try {
    produced = await packer({ dir: source, outDir: staging })
  } catch (err) {
    return { ok: false, reason: `打包失败：${err?.message ?? err}` }
  }
  if (!produced) return { ok: false, reason: '打包没有产出文件（这个目录可能不是 npm 包）' }

  const size = (await stat(produced)).size
  if (size > MAX_LOCAL_BYTES) {
    return { ok: false, reason: `打包产物 ${Math.round(size / 1024 / 1024)} MB，超过 100 MB 上限` }
  }
  // 产物名不一定等于包名，统一改成 `<包名>.tgz`，目标机那边好认。
  const rel = `plugins/local/${sanitize(name)}.tgz`
  const dest = join(outRoot, rel)
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(produced, dest)
  return { ok: true, rel, bytes: size, source: toPosix(source) }
}

/**
 * 跑一条外部命令。
 *
 * Windows 上 `npm` 实际是 `npm.cmd`，**不能直接 execFile**（实测 `spawn EINVAL`）：
 * 批处理文件必须由命令行解释器执行。所以这里统一经 `cmd /c`，让 PATHEXT 自己去解析。
 */
function runCommand(command, args, options) {
  if (process.platform !== 'win32') return run(command, args, options)
  const comspec = process.env.ComSpec || 'cmd.exe'
  return run(comspec, ['/d', '/s', '/c', command, ...args], options)
}

/** 真实打包：优先 npm，其次 pnpm（有些机器只装了一个）。 */
async function defaultPack({ dir, outDir }) {
  const attempts = [
    ['npm', ['pack', '--pack-destination', outDir]],
    ['pnpm', ['pack', '--pack-destination', outDir]],
  ]
  let lastError = null
  for (const [command, args] of attempts) {
    try {
      const before = new Set(await readdir(outDir))
      const { stdout } = await runCommand(command, args, { cwd: dir, maxBuffer: 8 * 1024 * 1024 })
      const after = await readdir(outDir)
      // 优先用 npm 自己报的文件名；报不出来就找新增的那个。
      const named = String(stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.endsWith('.tgz'))
        .pop()
      if (named && after.includes(basename(named))) return join(outDir, basename(named))
      const fresh = after.filter((f) => !before.has(f) && f.endsWith('.tgz'))
      if (fresh.length) return join(outDir, fresh[fresh.length - 1])
      // 既没报名字也没有新文件：多半这个目录不是 npm 包。
      return null
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(lastError?.message ?? '找不到 npm 或 pnpm')
}

/** 包名进文件名要安全：`@scope/name` → `scope__name`。 */
function sanitize(name) {
  return String(name || 'plugin').replace(/^@/, '').replace(/[\\/:*?"<>|]+/g, '__')
}

/**
 * 导入时把包里的 tarball 落到本机，返回可以直接用的 `file:` 路径。
 *
 * 为什么落到 `$DSH_HOME` 而不是临时目录：包管理器会把 `file:` 解析成一条**持久依赖**，
 * 临时目录被清掉之后，下次启动就会因为"依赖指向的文件没了"而报错。
 */
export async function materializeLocalTarball({ packDir, rel, home, name }) {
  const source = join(packDir, rel)
  const dir = join(home, 'dsh-everywhere', 'souls', 'imported', sanitize(name))
  await mkdir(dir, { recursive: true })
  const dest = join(dir, basename(rel))
  await copyFile(source, dest)
  return toPosix(dest)
}
