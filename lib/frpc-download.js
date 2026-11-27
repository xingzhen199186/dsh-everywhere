/**
 * 按需取回 frpc（2026-11-27）。
 *
 * 背景：可执行文件是发布扫描最刺眼的信号，所以 npm 包里不再带 frpc.exe。
 * 但"用户不该为了自建中继去手动找文件"——cloudflared 早就是自动下载的，
 * frpc 走同一条路，体验才一致。
 *
 * 三个原则：
 *   ① 只在用户真的开启自建中继时才下载；
 *   ② 下载后**核对 sha256**（钉死在上面的常量里），对不上就删掉并报错；
 *   ③ 从项目自己的 Releases 取（我们是发布者，能保证内容），带镜像兜底。
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'

export const FRPC_VERSION = '0.71.1'
// 2026-11-27：frp 本体版本与插件 Release 标签不是一回事；附件随插件 v0.3.1 发布。
export const FRPC_RELEASE_TAG = 'v0.3.1'
export const FRPC_SHA256 = '23d11640bee87207c7a99d006b84c554df997feeba7ac7243db20a88a9cb5e01'
const ASSET = process.platform === 'win32' ? 'frpc.exe' : 'frpc'

const MIRRORS = [
  (url) => url,
  (url) => `https://ghproxy.net/${url}`,
  (url) => `https://gh.ddlc.top/${url}`,
]

function sources() {
  const base = `https://github.com/xingzhen199186/dsh-everywhere/releases/download/${FRPC_RELEASE_TAG}`
  return MIRRORS.map((wrap) => wrap(`${base}/${ASSET}`))
}

async function fetchTo(url, target) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'dsh-everywhere' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (!res.body) throw new Error('没有响应体')
  await pipeline(Readable.fromWeb(res.body), createWriteStream(target))
}

/**
 * 确保数据目录下有一份可用的 frpc。返回路径；取不到就抛出带原因的错误。
 */
export async function ensureFrpc({ dataDir, log } = {}) {
  const dir = join(dataDir, 'bin')
  const target = join(dir, ASSET)
  if (existsSync(target) && statSync(target).size > 1024 * 1024) return target

  mkdirSync(dir, { recursive: true })
  const tmp = `${target}.part`
  const failures = []
  for (const url of sources()) {
    try {
      log?.info?.('正在取回 frpc（自建中继需要，约 16MB，只需一次）…')
      await fetchTo(url, tmp)
      const got = createHash('sha256').update(await (await import('node:fs/promises')).readFile(tmp)).digest('hex')
      if (got !== FRPC_SHA256) throw new Error(`校验不过（得到 ${got.slice(0, 12)}…）`)
      renameSync(tmp, target)
      log?.info?.(`frpc 已就绪：${target}`)
      return target
    } catch (err) {
      failures.push(`${new URL(url).host} — ${err?.message ?? err}`)
      rmSync(tmp, { force: true })
    }
  }
  throw new Error(
    '没能自动取回 frpc（自建中继需要它）。\n'
    + failures.map((f) => `  ${f}`).join('\n')
    + '\n也可以到项目 Releases 页手动下载 frpc.exe，放进数据目录的 bin/ 下。',
  )
}
