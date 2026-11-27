/**
 * 会话日志的第一帧处理。
 *
 * 会话文件是**多个 zstd 帧首尾相接**的追加日志：第一帧是头部（`{"type":"session",…,"cwd":…}`），
 * 后面每追加一批事件就是一帧。实测一份 26,039 字节的文件用 `zstdDecompressSync` **只解出
 * 第一帧**（187 字节、1 行）——这既是难点也是机会：改 cwd 只需要换掉第一帧，其余字节原样保留。
 *
 * 底线：**任何一步对不上就原样不动**。宁可这条会话搬不过去被跳过，也不能写出一份解不开的文件。
 */
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数（小端 0xFD2FB528）。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 找出第一帧的结束位置（不含）。
 *
 * 做法：从偏移 4 之后扫魔数，对每个候选边界**用解压验证**——能解出合法文本才算数。
 * 不解析帧头里的块信息：那要跟着 zstd 规范走一遍，出错的面比"多试几个候选"大得多。
 *
 * @returns {number} 第一帧的字节数；找不到可靠边界时返回整个长度（当作单帧）。
 */
export function firstFrameLength(buffer) {
  let index = buffer.indexOf(MAGIC, 4)
  while (index !== -1) {
    try {
      const text = zstdDecompressSync(buffer.subarray(0, index)).toString('utf8')
      if (text.trim().length > 0) return index
    } catch {
      // 这个位置不是帧边界，继续往后找。
    }
    index = buffer.indexOf(MAGIC, index + 4)
  }
  return buffer.length
}

/** 解出头部那一行 JSON。解不开返回 null，不抛。 */
export function readHeader(buffer) {
  const first = buffer.subarray(0, firstFrameLength(buffer))
  try {
    const text = zstdDecompressSync(first).toString('utf8')
    const line = text.split('\n').find((l) => l.trim().length > 0)
    if (!line) return null
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 只改第一帧里的 `cwd`，其余帧原样拼回去。
 *
 * @returns {{ok: boolean, buffer?: Buffer, reason?: string, before?: string, after?: string}}
 */
export function rewriteHeaderCwd(buffer, newCwd) {
  const frameLength = firstFrameLength(buffer)
  let header
  try {
    const text = zstdDecompressSync(buffer.subarray(0, frameLength)).toString('utf8')
    const newlineAt = text.indexOf('\n')
    const firstLine = newlineAt === -1 ? text : text.slice(0, newlineAt)
    header = JSON.parse(firstLine)
    if (!header || typeof header !== 'object') return { ok: false, reason: '第一帧不是 JSON 对象' }

    const before = typeof header.cwd === 'string' ? header.cwd : undefined
    if (before === newCwd) return { ok: true, buffer, reason: '无需改写', before, after: newCwd }

    header.cwd = newCwd
    // 保持原文件的换行习惯：原来有换行才补换行。
    const rebuilt = `${JSON.stringify(header)}${newlineAt === -1 ? '' : '\n'}`
    const recompressed = zstdCompressSync(Buffer.from(rebuilt, 'utf8'))
    const next = Buffer.concat([recompressed, buffer.subarray(frameLength)])

    // 写完立刻自检：两帧都必须还能解压，而且头部真的是新值。
    const check = readHeader(next)
    if (!check || check.cwd !== newCwd) return { ok: false, reason: '改写后自检不通过' }
    if (frameLength < buffer.length) {
      try {
        zstdDecompressSync(next.subarray(recompressed.length))
      } catch {
        return { ok: false, reason: '改写后第二帧解不开' }
      }
    }
    return { ok: true, buffer: next, before, after: newCwd }
  } catch (err) {
    return { ok: false, reason: `解不开第一帧：${err?.message ?? err}` }
  }
}

/**
 * 由工作区路径算出会话目录名（projectKey）。
 *
 * 规则是从真实目录反推的：`C:\Users\WINDOWS` → `--C-Users-WINDOWS--`，
 * `D:\X\X` → `--D-X-X--`。即：去掉盘符后的冒号、把分隔符折成 `-`、首尾各包两个 `-`。
 * 点号与中文都保留（实测 `--C-Users-WINDOWS-.dsh-profiles-desktop--` 就是这样）。
 */
export function projectKeyOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const withoutDriveColon = trimmed.replace(/^([A-Za-z]):/, '$1')
  const joined = withoutDriveColon.replace(/[\\/]+/g, '-')
  return `--${joined}--`
}
