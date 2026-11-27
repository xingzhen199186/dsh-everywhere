/**
 * 把 APK 传到 R2（App 自动更新取的那份）。2026-11-27。
 *
 * 为什么单独一个脚本：r2.dev 的公开发布目录只放"准备对外"的正式包，
 * 上传需要 S3 签名，用仓库里已有的 Node 就能做，不必依赖 wrangler。
 *
 * 用前准备（都在仓库外）：
 *   I:\极简遥控器\keys\r2-upload.env   → R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
 *   R2_ACCOUNT_ID 环境变量，或用 --account 传入
 *
 * 用法：
 *   node scripts/publish-app.mjs <apk路径> [--account <账号ID>] [--name <云端文件名>]
 */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const pick = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : null
}
if (!file) {
  console.error('用法：node scripts/publish-app.mjs <apk路径> [--account <账号ID>] [--name <云端文件名>]')
  process.exit(1)
}

const envFile = process.env.R2_ENV_FILE || 'I:/极简遥控器/keys/r2-upload.env'
const env = {}
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line)
  if (m) env[m[1]] = m[2]
}

const account = pick('--account') || process.env.R2_ACCOUNT_ID
const accessKey = env.R2_ACCESS_KEY_ID
const secretKey = env.R2_SECRET_ACCESS_KEY
const bucket = process.env.R2_BUCKET || 'dsh-everywhere'
if (!account || !accessKey || !secretKey) {
  console.error('缺少账号 ID 或密钥（检查 r2-upload.env 与 --account）')
  process.exit(1)
}

const key = pick('--name') || basename(file)
const host = `${account}.r2.cloudflarestorage.com`
const url = `https://${host}/${bucket}/${encodeURIComponent(key)}`
const body = readFileSync(file)
const payloadHash = createHash('sha256').update(body).digest('hex')

const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
const dateStamp = amzDate.slice(0, 8)
const contentType = 'application/vnd.android.package-archive'
const canonicalHeaders = [
  `content-type:${contentType}`,
  `host:${host}`,
  `x-amz-content-sha256:${payloadHash}`,
  `x-amz-date:${amzDate}`,
].join('\n')
const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date'
const canonicalRequest = ['PUT', `/${bucket}/${key}`, '', canonicalHeaders, '', signedHeaders, payloadHash].join('\n')
const scope = `${dateStamp}/auto/s3/aws4_request`
const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n')

const hmac = (k, d) => createHmac('sha256', k).update(d).digest()
let signingKey = hmac(`AWS4${secretKey}`, dateStamp)
signingKey = hmac(signingKey, 'auto')
signingKey = hmac(signingKey, 's3')
signingKey = hmac(signingKey, 'aws4_request')
const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

const res = await fetch(url, {
  method: 'PUT',
  body,
  headers: {
    'content-type': contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  },
})

if (!res.ok) {
  console.error(`上传失败：HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
  process.exit(1)
}
console.log(`已上传 ${key}（${(statSync(file).size / 1048576).toFixed(1)} MB）`)
