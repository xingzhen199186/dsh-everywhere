/**
 * 移魂的"现场信息"：DSH home 在哪、当前是哪个档案、这台 DSH 是什么版本。
 *
 * 这一层只做**只读探测**，不写任何东西。写操作一律在 apply 那一侧、且必须走服务。
 *
 * 为什么档案名要猜：DSH 没有把"当前档案叫什么"作为服务暴露出来（`profileContext` 只给
 * `startedBundles`）。所以这里用「启动时实际加载的 bundle 集合」去和各档案的
 * `dsh.profile.bundles` 比对，命中最多且唯一才算认出来；认不准就返回 null，
 * 让调用方要求用户显式指定——**宁可问一句，也不能往错的档案里写**。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

/** `$DSH_HOME`，缺省 `~/.dsh`。和插件其余部分同一套口径。 */
export function resolveHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

/** `$DSH_HOME/profiles` 下所有档案名（`node_modules` 不是档案）。 */
export function listProfileNames(home = resolveHome()) {
  const dir = join(home, 'profiles')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** 读某个档案的 `package.json`：组合（有序 bundle 列表）+ 依赖。读不到就是空。 */
export function readProfileManifest(home, name) {
  const file = join(home, 'profiles', name, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { name, found: false, bundles: [], dependencies: {} }
  }
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles)
    ? pkg.dsh.profile.bundles.filter((x) => typeof x === 'string')
    : []
  const dependencies = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  return { name, found: true, bundles, dependencies }
}

/**
 * 用「启动时加载的 bundle」猜当前档案。
 *
 * @returns {{name: string|null, candidates: string[], reason: string}}
 *   认准了给 name；认不准给候选列表和原因，让调用方去问用户。
 */
export function detectProfile(home, startedBundles = [], explicit) {
  const names = listProfileNames(home)
  if (explicit) {
    return names.includes(explicit)
      ? { name: explicit, candidates: [], reason: '由调用方指定' }
      : { name: null, candidates: names, reason: `指定的档案「${explicit}」不存在` }
  }
  if (names.length === 0) return { name: null, candidates: [], reason: '这台机器上没有 profiles 目录' }
  // 单档案时没有歧义，直接用它。
  if (names.length === 1) return { name: names[0], candidates: names, reason: '只有一个档案' }
  const started = new Set((startedBundles || []).filter((x) => typeof x === 'string'))
  if (started.size === 0) {
    return { name: null, candidates: names, reason: '拿不到启动 bundle，无法判断当前档案' }
  }
  const scored = names.map((name) => {
    const { bundles } = readProfileManifest(home, name)
    const hit = bundles.filter((b) => started.has(b)).length
    return { name, hit }
  })
  scored.sort((a, b) => b.hit - a.hit)
  const best = scored[0]
  const second = scored[1]
  if (!best || best.hit === 0) {
    return { name: null, candidates: names, reason: '没有档案和启动 bundle 对得上' }
  }
  if (second && second.hit === best.hit) {
    return { name: null, candidates: names, reason: '有两个档案一样像，无法确定' }
  }
  return { name: best.name, candidates: names, reason: `按启动 bundle 命中 ${best.hit} 项判定` }
}

/**
 * 正在跑的 DSH 版本。**问宿主，不翻磁盘**：磁盘上那份 `package.json` 可能是命令行那份，
 * 版本号不一定等于正在跑的这一只。
 */
export async function resolveDshVersion(ctx) {
  const mgr = ctx?.get?.('pluginManager')
  try {
    const got = await mgr?.listVersionExemptions?.()
    if (typeof got?.runtimeVersion === 'string' && got.runtimeVersion) return got.runtimeVersion
  } catch {
    // 问不到就往下退。
  }
  try {
    const bundles = await mgr?.listBundles?.()
    const base = (bundles || []).find((b) => b?.name === '@deepseek-ai/dsh-base')
    if (typeof base?.version === 'string' && base.version) return base.version
  } catch {
    // 都没有就如实说不知道。
  }
  return 'unknown'
}
