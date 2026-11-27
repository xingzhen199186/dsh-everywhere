/**
 * 取回"编 APK 或发版要用、但不入库"的二进制（2026-11-27）。
 *
 * 为什么不在仓库里：Git 不擅长二进制，几十 MB 的文件进历史就删不掉；来源也说不清。
 * 所以仓库只留 build-deps.json 这份清单（名字、大小、sha256、用途、来源），
 * 文件本身挂在 Releases 的固定 tag `build-deps` 下。
 *
 * 用法：
 *   node scripts/fetch-build-deps.mjs          下载缺失的，已存在且哈希对就跳过
 *   node scripts/fetch-build-deps.mjs --check  只检查，不下载（缺什么、坏什么）
 *   node scripts/fetch-build-deps.mjs --force  即使已存在也重新下载
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const list = JSON.parse(readFileSync(join(root, 'build-deps.json'), 'utf8'))
const checkOnly = process.argv.includes('--check')
const force = process.argv.includes('--force')

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

async function download(url, target) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'dsh-everywhere' } })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.part`
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
  renameSync(tmp, target)
}

let missing = 0
let bad = 0
for (const item of list.files) {
  const target = join(root, item.path)
  const state = !existsSync(target)
    ? '缺失'
    : statSync(target).size !== item.bytes
      ? '大小不对'
      : sha256(target) !== item.sha256
        ? '哈希不符'
        : '正常'

  if (state === '正常' && !force) {
    console.log(`✓ ${item.name}（${(item.bytes / 1048576).toFixed(1)} MB）已就位`)
    continue
  }
  if (state === '缺失') missing += 1
  else bad += 1

  if (checkOnly) {
    console.log(`✗ ${item.name}：${state}（应放 ${item.path}）`)
    continue
  }
  const url = `${list.release}/${item.name}`
  process.stdout.write(`… 取回 ${item.name}（${state}）`)
  try {
    await download(url, target)
    if (sha256(target) !== item.sha256) throw new Error('哈希不符')
    console.log(' 完成')
  } catch (err) {
    rmSync(target, { force: true })
    console.log(` 失败：${err?.message ?? err}`)
    console.log(`  手动下载：${url} → 放到 ${item.path}`)
    process.exitCode = 1
  }
}

if (checkOnly) {
  console.log(`\n检查完毕：缺失 ${missing} 个，异常 ${bad} 个。`)
}
