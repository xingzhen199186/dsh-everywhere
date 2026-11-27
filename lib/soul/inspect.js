/**
 * 体检：只读地看一份灵魂包里有什么、和这台机器差在哪。
 *
 * 这一层**绝不写盘**。它的价值是让用户在动手前先看清"要付出什么代价"：
 * 哪些包目标机没有、哪些配置会覆盖、哪些文件会新增。
 */
import { join } from 'node:path'
import { readManifest, verifyPack } from './pack.js'
import { readProfileManifest } from './env.js'
import { readTextFile } from './export.js'
import { readSessionIndex, listPackAttachments } from './sessions.js'
import { packHasSecrets } from './secrets.js'
import { listPackPluginDataAreas } from './plugin-data.js'

/** 读一个 JSON 分区，读不到给 null（不是空对象——"没有"和"空"要分得开）。 */
async function readJson(root, rel) {
  const text = await readTextFile(join(root, rel))
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * @param {object} p
 * @param {string} p.packDir 灵魂包目录
 * @param {object} p.ctx 插件 ctx（只读服务）
 * @param {string} p.home `$DSH_HOME`
 * @returns {Promise<object>} 体检报告
 */
export async function inspectSoul({ packDir, ctx, home }) {
  const read = await readManifest(packDir)
  if (!read.ok) return { ok: false, error: read.error }
  const manifest = read.manifest

  const verify = await verifyPack(packDir)
  const bundlesFile = await readJson(packDir, 'profile/bundles.json')
  const depsFile = await readJson(packDir, 'profile/dependencies.json')
  const settingsFile = await readJson(packDir, 'settings/namespaces.json')

  const pluginManager = ctx?.get?.('pluginManager')
  let liveBundles = []
  try {
    liveBundles = (await pluginManager?.listBundles?.()) || []
  } catch {
    // 读不到就当作"目标机状态未知"，下面按未知处理。
  }
  const liveByName = new Map((liveBundles || []).map((b) => [b?.name, b]))

  const sourceBundles = Array.isArray(bundlesFile?.bundles) ? bundlesFile.bundles : []
  // 目标机有没有这个包：**看证据，不看单一字段**。
  // 核心 bundle（例如 @deepseek-ai/dsh-base）是随应用带的，不在 npm 依赖里，
  // 单看 listBundles 的 installed 会把它们误判成"缺失"（2026-11-17 真机就是这样）。
  const deps = new Set(Object.keys(readProfileManifest(home, manifest?.source?.profile || '').dependencies || {}))
  const missing = []
  const disabled = []
  for (const item of sourceBundles) {
    if (!item || typeof item.name !== 'string') continue
    const live = liveByName.get(item.name)
    const present = Boolean(
      (live && (live.installed !== false || live.enabled === true || typeof live.version === 'string')) ||
      deps.has(item.name),
    )
    if (!present) missing.push(item.name)
    else if (live && live.enabled === false) disabled.push(item.name)
  }

  let liveDshVersion = 'unknown'
  try {
    const mgr = ctx?.get?.('pluginManager')
    const got = await mgr?.listVersionExemptions?.()
    if (typeof got?.runtimeVersion === 'string') liveDshVersion = got.runtimeVersion
  } catch {
    // 问不到就按 unknown 处理，下面版本比对会因此显示不一致。
  }

  const settings = ctx?.get?.('settings')
  let liveNamespaces = null
  if (settings && typeof settings.describeAll === 'function') {
    try {
      const all = await settings.describeAll.call(settings, { redactSecrets: true })
      liveNamespaces = new Map((all || []).map((e) => [e?.ns, e?.info]))
    } catch {
      liveNamespaces = null
    }
  }
  const sourceNamespaces = Object.keys(settingsFile?.namespaces || {})
  const nsMissing = []
  const nsChanged = []
  if (liveNamespaces) {
    for (const ns of sourceNamespaces) {
      const live = liveNamespaces.get(ns)
      if (!live) nsMissing.push(ns)
      else nsChanged.push(ns)
    }
  }

  const sessionIndex = await readSessionIndex(packDir)
  const attachmentObjects = await listPackAttachments(packDir)

  const sourceProfile = manifest?.source?.profile ?? null
  const targetProfileExists = Boolean(sourceProfile) && readProfileManifest(home, sourceProfile).found

  return {
    ok: true,
    manifest: {
      format: manifest.format,
      createdAt: manifest.createdAt,
      source: manifest.source,
      includes: manifest.includes,
      counts: manifest.counts,
      bytes: manifest.bytes,
      fileCount: manifest.fileCount,
      notes: manifest.notes || [],
    },
    integrity: { ok: verify.ok, problems: verify.problems, extra: verify.extra },
    content: {
      bundles: sourceBundles.length,
      dependencies: depsFile ? Object.keys(depsFile).length : 0,
      settingsNamespaces: sourceNamespaces.length,
      hasHomePatch: Boolean(await readTextFile(join(packDir, 'profile/patches/home.cordis.patch.yml'))),
      hasProfilePatch: Boolean(await readTextFile(join(packDir, 'profile/patches/profile.cordis.patch.yml'))),
      sessions: sessionIndex?.sessions?.length ?? 0,
      sessionBytes: sessionIndex?.bytes ?? 0,
      attachments: attachmentObjects.length,
      hasSecrets: await packHasSecrets(packDir),
      pluginDataAreas: (await listPackPluginDataAreas(packDir)).length,
    },
    target: {
      profile: sourceProfile,
      // 会话格式有版本：两端不一致时不搬会话，这里先把话说在前面。
      liveDshVersion,
      versionMatches: liveDshVersion === 'unknown' || manifest?.source?.dshVersion === liveDshVersion,
      profileExists: targetProfileExists,
      // 目标机缺哪些包、哪些只是没启用 —— 这两类在 P1 里的处理完全不同。
      missingBundles: missing,
      disabledBundles: disabled,
      settingsUnavailable: liveNamespaces === null,
      settingsMissing: nsMissing,
      settingsPresent: nsChanged,
    },
    // 一眼能给人看的判断：能不能直接注入，还是只能部分注入。
    // 版本不一致 = **不能注入**，不是"少搬一点"。跨版本写插件组合与补丁可能损坏本机 DSH。
    blocked: liveDshVersion !== 'unknown' && manifest?.source?.dshVersion !== liveDshVersion
      ? {
          sourceVersion: manifest?.source?.dshVersion,
          liveVersion: liveDshVersion,
          reason: `版本不一致：包来自 DSH ${manifest?.source?.dshVersion}，本机是 ${liveDshVersion}。先统一版本再注入。`,
        }
      : null,
    verdict: !verify.ok
      ? '这个包校验不过，不能注入'
      : (liveDshVersion !== 'unknown' && manifest?.source?.dshVersion !== liveDshVersion)
        ? `版本不一致（包 ${manifest?.source?.dshVersion}，本机 ${liveDshVersion}）：不能注入，先统一 DSH 版本`
      : (manifest?.includes?.sessions && liveDshVersion !== 'unknown' && manifest?.source?.dshVersion !== liveDshVersion)
        ? `两端 DSH 版本不同（包 ${manifest?.source?.dshVersion}，本机 ${liveDshVersion}）：配置能搬，会话这次不搬（避免搬出读不出来的数据）`
      : missing.length > 0
        ? `有 ${missing.length} 个插件目标机没装；P1 不会替你装（需要 P2），这些会跳过`
        : '结构层的插件目标机都有，可以注入',
  }
}
