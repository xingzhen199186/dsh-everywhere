/**
 * 导出"灵魂"的**结构层 + 配置层**（P1 范围）。
 *
 * P1 只搬两样东西：
 *   · 结构层 —— 这个档案装了哪些 bundle、什么顺序、什么版本；
 *   · 配置层 —— 各插件的生效配置（经 settings 服务读，读的是活值）、两层 patch、AGENTS.md、技能、预设。
 *
 * **不碰**会话与附件（P3）、不碰凭据值（P4）、不装任何包（P2）。范围小是故意的：
 * 这两层搬对了，目标机才算"像本尊"；搬错了，最多是配置不对，不会把机器搞坏。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { copyInto, finalizePack, listFilesDeep, toPosix, writeJsonFile } from './pack.js'
import { listProfileNames, readProfileManifest, resolveDshVersion, resolveHome } from './env.js'
import { isLocalSpec, packLocalPlugin } from './local-plugin.js'
import { exportSessions, exportAttachments } from './sessions.js'
import { collectSecrets, writeSecrets } from './secrets.js'
import { discoverPluginDataAreas, exportPluginData } from './plugin-data.js'

/** 读 settings 的全部 namespace（redacted）。宿主没有 `describeAll` 就如实说读不到。 */
async function readSettings(ctx, home, profile) {
  const settings = ctx?.get?.('settings')
  if (!settings) return { ok: false, reason: '这台 DSH 没有 settings 服务' }
  const describeAll = settings.describeAll
  if (typeof describeAll !== 'function') {
    // 退化路径：宿主没有 describeAll 时，从 `settings.yaml` 的顶层键拿到**名字**，
    // 再逐个 describe。真实机器上就是这条：没有它，配置层会一条都导不出去
    // （2026-11-17 真机导出实测「配置条目 0 条」才发现）。
    const names = await collectNamespaceNames(home, profile)
    if (names.length === 0) {
      return { ok: false, reason: '这台 DSH 既没有 describeAll，settings.yaml 里也没有可用的名字' }
    }
    const namespaces = {}
    const failed = []
    for (const ns of names) {
      try {
        const info = await settings.describe(ns, { redactSecrets: true })
        if (!info) continue
        namespaces[ns] = {
          value: info.value ?? null,
          revision: typeof info.revision === 'number' ? info.revision : null,
        }
      } catch {
        // 名字在文件里、但这一条现在不可配置（插件卸了之类）：跳过并计数。
        failed.push(ns)
      }
    }
    return { ok: true, namespaces, degraded: true, skipped: failed.length }
  }
  try {
    const all = await describeAll.call(settings, { redactSecrets: true })
    const namespaces = {}
    for (const entry of all || []) {
      const ns = entry?.ns
      const info = entry?.info
      if (typeof ns !== 'string' || !ns) continue
      namespaces[ns] = {
        value: info?.value ?? null,
        revision: typeof info?.revision === 'number' ? info.revision : null,
      }
    }
    return { ok: true, namespaces }
  } catch (err) {
    return { ok: false, reason: `读配置失败：${err?.message ?? err}` }
  }
}

/**
 * 收集"要问哪些 namespace"的清单。
 *
 * 两个来源，**都只读名字不读值**：
 *   1. `$DSH_HOME/settings.yaml` 的顶层键——这台机器上它**只剩 1 个**（其余早被导入进
 *      profile patch 了），所以不能只靠它；
 *   2. 两层 `cordis.patch.yml` 里每条 `- id: xxx`——**真正装着的配置条目都在这儿**
 *      （真机实测 80 条）。少了这一路，配置层就只导得出一条（2026-11-17 真机导出实测）。
 *
 * 名字拿到之后逐个 `describe`，条目不存在会抛错，自然被过滤掉。
 */
async function collectNamespaceNames(home, profile) {
  const names = new Set()
  const skip = new Set(['version', 'namespaces'])

  for (const file of ['settings.yaml', 'settings.yaml.imported']) {
    try {
      const text = await readFile(join(home, file), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        const match = /^([A-Za-z0-9_.@-]+):/.exec(line)
        if (match && !skip.has(match[1])) names.add(match[1])
      }
    } catch {
      // 这个文件名没有就换下一个。
    }
  }

  const patchFiles = [join(home, 'cordis.patch.yml'), join(home, 'profiles', profile, 'cordis.patch.yml')]
  for (const file of patchFiles) {
    try {
      const text = await readFile(file, 'utf8')
      for (const match of text.matchAll(/^\s*-\s*id:\s*(\S+)/gm)) {
        const id = match[1].replace(/["']/g, '')
        if (id && !skip.has(id)) names.add(id)
      }
    } catch {
      // 这一层没有 patch 就跳过。
    }
  }

  return [...names]
}

/** 把 bundle 列表与运行中的实际状态对齐：版本、是否装、是否启用。 */
function mergeBundles(ordered, runtimeList) {
  const byName = new Map()
  for (const item of runtimeList || []) {
    if (item && typeof item.name === 'string') byName.set(item.name, item)
  }
  return ordered.map((name) => {
    const live = byName.get(name)
    const version = typeof live?.version === 'string' ? live.version : null
    const spec = typeof live?.installTarget?.spec === 'string' ? live.installTarget.spec : null
    return {
      name,
      // 档案里写着，但目标对象没报出来：可能没装。导入时要按"装没装"分别处理。
      installed: live ? live.installed !== false : false,
      enabled: live ? live.enabled !== false : true,
      version,
      // 装包要的是"怎么装"，不是"装在哪"：优先用宿主给的安装源；
      // 它没给（例如只在 bundles 里声明过的包）就用 name@version 兜底。
      spec: spec || (version ? `${name}@${version}` : name),
      specSource: spec ? 'installTarget' : 'name-version',
      official: live?.official === true,
    }
  })
}

/**
 * 导出。
 *
 * @param {object} p
 * @param {object} p.ctx 插件 ctx（用来读服务，只读）
 * @param {string} p.home `$DSH_HOME`
 * @param {string} p.profile 档案名（已由调用方确认，不接受"猜"）
 * @param {string} p.outDir 输出目录（不存在会自动建）
 * @returns {Promise<object>} 摘要：写了什么、跳过了什么、多大
 */
export async function exportSoul({ ctx, home, profile, outDir, runPack, sessions = 'none', sessionLimit = 20, attachments = false, password = '', pluginData = false }) {
  const notes = []
  const manifest = readProfileManifest(home, profile)
  if (!manifest.found) {
    return { ok: false, error: `档案「${profile}」下没有 package.json，不像是一个档案目录` }
  }

  const dshVersion = await resolveDshVersion(ctx)
  const pluginManager = ctx?.get?.('pluginManager')
  let runtimeBundles = []
  try {
    runtimeBundles = (await pluginManager?.listBundles?.()) || []
  } catch (err) {
    notes.push(`读不到运行中的 bundle 状态（${err?.message ?? err}），版本与安装状态会缺`)
  }

  // ── 结构层 ──
  const merged = mergeBundles(manifest.bundles, runtimeBundles)

  /**
   * **只带走"用户自己装的"，内置的不搬**（2026-11-20 用户提出，同天真机事故印证）。
   *
   * 判据看文件系统：这个档案的 `node_modules` 里有没有这个包。
   *   · 有 → 用户装的（第三方、本地源），必须同步；
   *   · 没有 → DSH 本体提供的（或根本没装）。两者都不该写进目标机的清单：
   *     前者跟着 DSH 版本走，后者在目标机也不存在。
   *
   * 事故原委：把 A 的整份清单写到 B，B 没有其中两个包，加载链在那里断掉，
   * 后面所有插件（包括本插件）的宿主路由都没挂上，表现是设置页一片 404。
   */
  /**
   * 安装源要**以档案的 dependencies 为准**（2026-11-20 真机）。
   *
   * 运行时清单里给的是 `名字@版本`，对注册表插件够用；但本地源插件的真实身份在
   * dependencies 里（`link:I:/...`、`file:...`）。只看运行时清单会把它记成
   * `name@version`，搬到目标机后就去 npm 找一个不存在的包，结果是 404。
   */
  const depSpecs = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  for (const b of merged) {
    const dep = depSpecs[b.name]
    if (typeof dep === 'string' && isLocalSpec(dep)) {
      b.spec = dep
      b.specSource = 'dependency-local'
      continue
    }
    // 注册表插件：拼装时有时只拿到名字。目标机按名字装会拿"最新版"，
    // 可能和源机器不是同一个版本 —— 所以补回版本号，装的就是同一个东西。
    if (typeof b.version === 'string' && b.version && !isLocalSpec(b.spec) && (!b.spec || !b.spec.includes('@', 1))) {
      b.spec = `${b.name}@${b.version}`
      b.specSource = 'name-version'
    }
  }

  const profileNodeModules = join(home, 'profiles', profile, 'node_modules')
  /**
   * 这个包"是不是用户自己装的"。
   *
   * 两条判据，任一成立即可：
   *   · 档案的 node_modules 里能找到它（正常的第三方安装）；
   *   · 它的安装源是本地路径 / link / file（开发者本地装，node_modules 里是链接）。
   *
   * 都不成立的，就是 DSH 本体内置的、或者清单里写着但其实没装的——一律不搬。
   */
  const isUserInstalled = (b) => {
    if (isLocalSpec(b.spec)) return true
    return existsSync(join(profileNodeModules, ...String(b.name).split('/'), 'package.json'))
  }
  const bundles = merged.filter((b) => isUserInstalled(b))
  const builtinNames = merged.filter((b) => !isUserInstalled(b)).map((b) => b.name)
  if (builtinNames.length) {
    notes.push(`内置/未安装的 ${builtinNames.length} 个插件不参与同步：${builtinNames.slice(0, 6).join('、')}${builtinNames.length > 6 ? ' 等' : ''}`)
  }

  // 本地源插件（link:/file:/裸路径）在目标机上必然找不到，必须把源码打成 tarball 带走。
  // 打不成的**不隐藏**：记进 notes，导入时那条会变成 skip，用户看得见缺了什么。
  let localPacked = 0
  for (const bundle of bundles) {
    if (!isLocalSpec(bundle.spec)) continue
    const packed = await packLocalPlugin({ name: bundle.name, spec: bundle.spec, home, outRoot: outDir, runPack })
    bundle.specKind = 'local'
    if (packed.ok) {
      bundle.localTarball = packed.rel
      bundle.localBytes = packed.bytes
      bundle.sourcePath = packed.source
      localPacked += 1
    } else {
      notes.push(`本地插件 ${bundle.name} 没打包：${packed.reason}`)
    }
  }
  await writeJsonFile(outDir, 'profile/bundles.json', {
    profile,
    order: bundles.map((b) => b.name),
    bundles,
  })
  // 依赖表也只留同步范围内的那批：内置插件由 DSH 自己带，写进去没意义、还可能误装。
  const keep = new Set(bundles.map((b) => b.name))
  const deps = Object.fromEntries(
    Object.entries(manifest.dependencies || {}).filter(([name]) => keep.has(name)),
  )
  await writeJsonFile(outDir, 'profile/dependencies.json', deps)

  // 两层 patch 原样带走：导入时是**整份替换**（官方口径：用户补丁非深合并），
  // 所以这里必须是原文，不能解析后再拼。
  const patchLayers = []
  const homePatch = join(home, 'cordis.patch.yml')
  if (await copyInto(outDir, 'profile/patches/home.cordis.patch.yml', homePatch)) {
    patchLayers.push('home')
  } else {
    notes.push('这台机器没有 home 层 patch（cordis.patch.yml），跳过')
  }
  const profilePatch = join(home, 'profiles', profile, 'cordis.patch.yml')
  if (await copyInto(outDir, 'profile/patches/profile.cordis.patch.yml', profilePatch)) {
    patchLayers.push('profile')
  } else {
    notes.push('这个档案没有自己的 cordis.patch.yml，跳过')
  }

  // ── 配置层 ──
  const settings = await readSettings(ctx, home, profile)
  if (settings.ok) {
    await writeJsonFile(outDir, 'settings/namespaces.json', {
      readAt: new Date().toISOString(),
      note: 'value 是 redacted 的生效值；revision 只用于对照，导入时会重新读。',
      namespaces: settings.namespaces,
    })
  } else {
    notes.push(`没有导出配置：${settings.reason}`)
    await writeJsonFile(outDir, 'settings/namespaces.json', {
      unavailable: true,
      reason: settings.reason,
      namespaces: {},
    })
  }

  // ── 自定义文件（提示词之外的那些"人写的"东西）──
  const custom = []
  const addFile = async (rel, abs) => {
    if (await copyInto(outDir, rel, abs)) custom.push(rel)
  }
  await addFile('custom/AGENTS.md', join(home, 'AGENTS.md'))

  const skillsDir = join(home, 'skills')
  if (existsSync(skillsDir)) {
    for (const abs of await listFilesDeep(skillsDir)) {
      const rel = toPosix(abs.slice(skillsDir.length + 1))
      await copyInto(outDir, `custom/skills/${rel}`, abs)
      custom.push(`custom/skills/${rel}`)
    }
    if (custom.filter((r) => r.startsWith('custom/skills/')).length === 0) {
      notes.push('skills/ 是空的，没有技能要带走')
    }
  } else {
    notes.push('这台机器没有 skills 目录')
  }

  const presetsDir = join(home, '.agent-presets')
  if (existsSync(presetsDir)) {
    for (const abs of await listFilesDeep(presetsDir)) {
      const rel = toPosix(abs.slice(presetsDir.length + 1))
      await copyInto(outDir, `custom/agent-presets/${rel}`, abs)
      custom.push(`custom/agent-presets/${rel}`)
    }
  } else {
    notes.push('这台机器没有 .agent-presets 目录')
  }

  // ── 记忆层（可选，默认不带）──
  const sessionExport = await exportSessions({ home, outDir, mode: sessions, limit: sessionLimit })
  notes.push(...sessionExport.notes)
  let attachmentExport = { objects: 0, bytes: 0, notes: [], available: 0 }
  if (attachments) {
    attachmentExport = await exportAttachments({ home, outDir })
    notes.push(...attachmentExport.notes)
  }

  // ── 插件私有数据（可选）──
  let pluginDataAreas = 0
  if (pluginData) {
    const profileDir = join(home, 'profiles', profile)
    const areas = await discoverPluginDataAreas({ profile, profileDir })
    if (areas.length === 0) {
      notes.push('没有发现可带的插件私有数据（内置表里没有本机装着的包，也没有插件自述 dataDirs）')
    } else {
      const packed = await exportPluginData({ areas, outDir })
      pluginDataAreas = packed.areas.length
      notes.push(...packed.notes)
      if (pluginDataAreas === 0) notes.push('发现了私有数据目录，但里面没有可带的文件')
    }
  }

  // ── 凭据层（只有给了密码才带；agent 永远拿不到密码）──
  let secretCount = 0
  if (password) {
    const collected = await collectSecrets(ctx, home)
    if (!collected.ok) {
      notes.push(`没有带走凭据：${collected.reason}`)
    } else if (collected.entries.length === 0) {
      notes.push('没有带走凭据：一条都没读到（可能都没配置）')
    } else {
      await writeSecrets(outDir, collected.entries, password)
      secretCount = collected.entries.length
      if (collected.skipped.length > 0) {
        notes.push(`有 ${collected.skipped.length} 条凭据读不到值，没有带走（名字不外泄，见设置页）`)
      }
    }
  }

  // ── 收尾 ──
  const full = await finalizePack(outDir, {
    kind: 'soul-export',
    createdAt: new Date().toISOString(),
    source: {
      home: toPosix(home),
      profile,
      dshVersion,
      nodeVersion: process.version,
      profiles: listProfileNames(home),
    },
    includes: {
      structure: true,
      config: settings.ok,
      custom: custom.length > 0,
      sessions: sessions !== 'none' && sessionExport.sessions.length > 0,
      attachments: attachments && attachmentExport.objects > 0,
      secrets: secretCount > 0,
      pluginData: pluginDataAreas > 0,
      pluginPackages: localPacked > 0,
    },
    counts: {
      bundles: bundles.length,
      settingsNamespaces: Object.keys(settings.ok ? settings.namespaces : {}).length,
      patchLayers: patchLayers.length,
      customFiles: custom.length,
      localPlugins: localPacked,
      sessions: sessionExport.sessions.length,
      sessionBytes: sessionExport.bytes,
      attachments: attachmentExport.objects,
      secrets: secretCount,
      pluginDataAreas,
    },
    notes,
  })

  return {
    ok: true,
    outDir,
    manifest: full,
    bytes: full.bytes,
    fileCount: full.fileCount,
    notes,
    bundles: bundles.length,
    settingsNamespaces: Object.keys(settings.ok ? settings.namespaces : {}).length,
    configExported: settings.ok,
    localPlugins: localPacked,
    sessions: sessionExport.sessions.length,
    attachments: attachmentExport.objects,
    secrets: secretCount,
    pluginDataAreas,
  }
}

/** 导出目录的默认位置：`$DSH_HOME/dsh-everywhere/souls/soul-<时间>`。 */
export function defaultExportDir(home) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  return join(home, 'dsh-everywhere', 'souls', `soul-${stamp}`)
}

/** 读一段文本（给"体检"看 manifest 用）。 */
export async function readTextFile(abs) {
  try {
    return await readFile(abs, 'utf8')
  } catch {
    return null
  }
}
