/**
 * 凭据层（P4）：把 API Key 之类**加密**带走，密码只在内存里过一道。
 *
 * 三条硬规矩：
 *   1. **密码不落盘、不进日志、不进 manifest**——只在一次调用的内存里存在。
 *   2. **agent 拿不到密码**：五个工具里没有密码参数，凭据只能由人在设置页里操作。
 *   3. **值从服务读、经服务写**：`credentials.resolve(ref)` 取值、`credentials.set(ref, value)`
 *      写回，不直接改 `.credentials.yaml`——那是宿主的所有物。
 *
 * 为什么 ref 名单要自己扫文件：凭据服务**没有枚举接口**（官方口径：配置面靠 settings
 * schema 学 ref 名），但 `.credentials.yaml` 的 `refs` 段就是那份名单。读名字不读值，
 * 值仍然只经服务拿。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeTextFile } from './pack.js'

/** 容器头：magic(4) + 版本(1) + salt(16) + iv(12) + tag(16) + 密文。 */
const MAGIC = Buffer.from('DSL1')
const VERSION = 1
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16

export const SECRETS_FILE = 'secrets/secrets.enc'

/** 从 `.credentials.yaml` 的 `refs:` 段读 ref 名单（只要名字）。 */
export async function listSecretRefs(home) {
  let text
  try {
    text = await readFile(join(home, '.credentials.yaml'), 'utf8')
  } catch {
    return []
  }
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^refs:\s*$/.test(line))
  if (start === -1) return []
  const refs = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\S/.test(line) && line.trim()) break // 走出 refs 段
    const match = /^\s{2}([A-Za-z0-9_.@-]+):/.exec(line)
    if (match) refs.push(match[1])
  }
  return refs
}

/**
 * 取凭据值。**只在内存里**，调用方用完就该丢。
 *
 * @returns {Promise<{ok:boolean, entries:Array<{ref:string, value:string}>, skipped:string[], reason?:string}>}
 */
export async function collectSecrets(ctx, home) {
  const credentials = ctx?.get?.('credentials')
  if (!credentials || typeof credentials.resolve !== 'function') {
    return { ok: false, entries: [], skipped: [], reason: '这台 DSH 没有 credentials 服务，读不到凭据' }
  }
  const refs = await listSecretRefs(home)
  if (refs.length === 0) {
    return { ok: false, entries: [], skipped: [], reason: '这台机器上没有已保存的凭据（.credentials.yaml 里没有 refs）' }
  }
  const entries = []
  const skipped = []
  for (const ref of refs) {
    try {
      const got = await credentials.resolve(ref)
      if (!got || typeof got.value !== 'string' || !got.value) {
        skipped.push(ref)
        continue
      }
      entries.push({ ref, value: got.value })
    } catch {
      skipped.push(ref)
    }
  }
  return { ok: true, entries, skipped }
}

/** scrypt 派生密钥：N=16384 是常见档位，够用又不至于让一次导出卡住。 */
function deriveKey(password, salt) {
  return scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 })
}

/**
 * 加密一份凭据集合。
 *
 * @param {Array<{ref:string, value:string}>} entries
 * @param {string} password 人给的密码，只在内存里
 * @returns {Buffer}
 */
export function encryptSecrets(entries, password) {
  if (!password || String(password).length < 6) {
    throw new Error('密码至少 6 位')
  }
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = deriveKey(password, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify({ entries }), 'utf8')
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv, tag, body])
}

/** 解密。密码不对或文件被动过都会抛错——两种情况都**不能**当成空数据。 */
export function decryptSecrets(buffer, password) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MAGIC.length + 1 + SALT_BYTES + IV_BYTES + TAG_BYTES) {
    throw new Error('凭据文件不完整')
  }
  if (!buffer.subarray(0, 4).equals(MAGIC)) throw new Error('不是本插件产出的凭据文件')
  const version = buffer[4]
  if (version !== VERSION) throw new Error(`凭据文件版本 ${version} 认不出来`)
  let offset = 5
  const salt = buffer.subarray(offset, offset + SALT_BYTES); offset += SALT_BYTES
  const iv = buffer.subarray(offset, offset + IV_BYTES); offset += IV_BYTES
  const tag = buffer.subarray(offset, offset + TAG_BYTES); offset += TAG_BYTES
  const body = buffer.subarray(offset)
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(password, salt), iv)
  decipher.setAuthTag(tag)
  let plaintext
  try {
    plaintext = Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new Error('密码不对，或者凭据文件被改过')
  }
  const parsed = JSON.parse(plaintext.toString('utf8'))
  if (!parsed || !Array.isArray(parsed.entries)) throw new Error('凭据内容格式不对')
  return parsed.entries
}

/** 写进灵魂包（只在给了密码时调用）。以 base64 存放：纯文本文件，不会被误当二进制弄坏。 */
export async function writeSecrets(packDir, entries, password) {
  const buffer = encryptSecrets(entries, password)
  await writeTextFile(packDir, SECRETS_FILE, buffer.toString('base64'))
  return { path: SECRETS_FILE, bytes: buffer.length, entries: entries.length }
}

/** 从包里读出来（base64 存的，以免被当成文本编辑器打开就坏掉）。 */
export async function readSecretsRaw(packDir) {
  const text = await readFile(join(packDir, SECRETS_FILE), 'utf8')
  return Buffer.from(text.trim(), 'base64')
}

/** 这个包里有没有凭据。 */
export async function packHasSecrets(packDir) {
  try {
    const text = await readFile(join(packDir, SECRETS_FILE), 'utf8')
    return text.trim().length > 0
  } catch {
    return false
  }
}

/**
 * 把凭据写回这台机器。逐条报告，**不因为一条失败就整笔放弃**——
 * 凭据之间互不相干，用户需要知道到底哪几条没写进去。
 */
export async function applySecrets(ctx, entries) {
  const credentials = ctx?.get?.('credentials')
  if (!credentials || typeof credentials.set !== 'function') {
    return { ok: false, written: [], failed: [], reason: '这台 DSH 没有 credentials 服务，写不进凭据' }
  }
  const written = []
  const failed = []
  for (const entry of entries) {
    try {
      await credentials.set(entry.ref, entry.value)
      written.push(entry.ref)
    } catch (err) {
      failed.push({ ref: entry.ref, reason: String(err?.message ?? err) })
    }
  }
  return { ok: failed.length === 0, written, failed }
}
