#!/usr/bin/env node
/**
 * 移魂带外回滚：插件没有加载起来时，也能用本机 Node 直接读快照急救。
 *
 * 只处理不依赖 DSH 服务的两类记录：文件原件、本次新装包的档案清单。
 * settings 与换版本仍需要宿主服务，绝不猜内部存储格式后假装已经恢复。
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const paths = args.filter((arg) => arg !== '--list')
if (paths.length !== 1 || args.some((arg) => arg.startsWith('--') && arg !== '--list')) {
  console.error('用法：node scripts/soul-offline-rollback.mjs [--list] <快照目录>')
  process.exit(2)
}

const snapshotDir = resolve(paths[0])
const readJson = (file, optional = false) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    if (optional && err?.code === 'ENOENT') return null
    throw new Error(`读不到 ${basename(file)}：${err?.message ?? err}`)
  }
}
const inside = (root, target) => {
  const base = resolve(root)
  const value = resolve(target)
  return value !== base && value.startsWith(base + sep)
}
const manifestState = (file) => {
  const text = readFileSync(file, 'utf8')
  const pkg = JSON.parse(text)
  return { file, text, pkg }
}
const bundleNames = (pkg) => Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
const mentions = (pkg, name) => bundleNames(pkg).includes(name)
  || Boolean(pkg?.dependencies && Object.prototype.hasOwnProperty.call(pkg.dependencies, name))

/** 推断 DSH home；新快照直接读计划绑定，旧快照按既定快照层级回推。 */
const homeOf = (result) => result?.targetBinding?.profilePath
  ? resolve(result.targetBinding.profilePath, '..', '..')
  : resolve(snapshotDir, '..', '..', '..', '..')

/** 旧日志没有档案路径时，只在候选唯一的情况下推断，绝不挑“看起来像”的那台档案。 */
const inferProfileDir = (home, name) => {
  const root = join(home, 'profiles')
  const candidates = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(root, entry.name, 'package.json')
    if (!existsSync(file)) continue
    try {
      if (mentions(JSON.parse(readFileSync(file, 'utf8')), name)) candidates.push(join(root, entry.name))
    } catch {
      // 损坏的候选不能拿来写。
    }
  }
  if (candidates.length !== 1) throw new Error(`无法唯一确定 ${name} 所属档案（找到 ${candidates.length} 个），需要新快照里的档案路径`)
  return candidates[0]
}

const journal = readJson(join(snapshotDir, 'journal.json'))
const result = readJson(join(snapshotDir, 'result.json'))
const entries = Array.isArray(journal?.entries) ? journal.entries : null
if (!entries || !result) throw new Error('快照必须同时包含有效的 journal.json 与 result.json；为避免误删，本次没有写入')

if (listOnly) {
  console.log(JSON.stringify({
    ok: true,
    listOnly: true,
    snapshotDir,
    planId: result.planId || null,
    targetBinding: result.targetBinding || null,
    entries: entries.map((entry) => ({ kind: entry.kind, target: entry.target, backup: entry.backup ?? null })),
    notes: Array.isArray(result.notes) ? result.notes : [],
  }, null, 2))
  process.exit(0)
}

const home = homeOf(result)
if (!inside(home, snapshotDir)) throw new Error(`快照不在预期 DSH 目录内：${snapshotDir}`)
const restored = []
const failed = []
const unsupported = []
const notes = []
const files = []
const bundles = new Map()

/** 安装前就写回滚日志，所以必须看 result，already-installed 不能反过来删掉原有包。 */
const installApplied = (name) => (Array.isArray(result.journal) ? result.journal : []).some((entry) =>
  entry?.kind === 'install' && entry?.action === 'install' && entry?.target === name
  && (entry?.result === 'applied' || entry?.result === 'restart-required'))

// 全部预检后再写，避免路径或 JSON 错误做到一半才暴露。
for (const entry of [...entries].reverse()) {
  if (entry?.kind === 'file') {
    if (!isAbsolute(entry.target) || !inside(home, entry.target)) throw new Error(`文件恢复目标越出 DSH 目录：${entry.target}`)
    if (entry.backup) {
      if (!isAbsolute(entry.backup) || !inside(join(snapshotDir, 'files'), entry.backup) || !existsSync(entry.backup)) {
        throw new Error(`文件备份不在当前快照内或已丢失：${entry.backup}`)
      }
    }
    files.push(entry)
    continue
  }
  if (entry?.kind !== 'bundle-install') {
    unsupported.push(`${entry?.target ?? entry?.kind}：${entry?.kind ?? '未知记录'} 需要插件内回滚`)
    continue
  }
  if (!installApplied(entry.target)) {
    notes.push(`${entry.target} 没有确认是本次新装，清单保持不动`)
    continue
  }
  const bound = result?.targetBinding?.profilePath
  if (entry.profilePath && bound && resolve(entry.profilePath) !== resolve(bound)) {
    throw new Error(`${entry.target} 的档案路径与计划绑定不一致`)
  }
  const profileDir = entry.profilePath || bound || inferProfileDir(home, entry.target)
  if (!inside(join(home, 'profiles'), profileDir)) throw new Error(`档案路径越界：${profileDir}`)
  const file = join(profileDir, 'package.json')
  if (!bundles.has(file)) bundles.set(file, { ...manifestState(file), names: new Set() })
  bundles.get(file).names.add(entry.target)
}

for (const entry of files) {
  try {
    if (entry.backup) {
      mkdirSync(dirname(entry.target), { recursive: true })
      copyFileSync(entry.backup, entry.target)
    } else {
      rmSync(entry.target, { force: true })
    }
    restored.push(`文件 ${entry.target}`)
  } catch (err) {
    failed.push(`${entry.target}：${err?.message ?? err}`)
  }
}

for (const state of bundles.values()) {
  try {
    const names = state.names
    if (state.pkg?.dsh?.profile && Array.isArray(state.pkg.dsh.profile.bundles)) {
      state.pkg.dsh.profile.bundles = state.pkg.dsh.profile.bundles.filter((name) => !names.has(name))
    }
    if (state.pkg.dependencies) {
      for (const name of names) delete state.pkg.dependencies[name]
    }
    const temp = `${state.file}.offline-${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(state.pkg, null, 2)}\n`, 'utf8')
    renameSync(temp, state.file)
    restored.push(`档案清单 ${state.file}（移除 ${[...names].join('、')}）`)
  } catch (err) {
    failed.push(`${state.file}：${err?.message ?? err}`)
  }
}

const ok = failed.length === 0 && unsupported.length === 0
console.log(JSON.stringify({ ok, listOnly: false, restored, failed, unsupported, notes }, null, 2))
process.exit(ok ? 0 : 1)
