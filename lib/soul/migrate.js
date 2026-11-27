/**
 * 计划 / 执行 / 回滚（P1 范围：结构层 + 配置层）。
 *
 * 三条硬规矩，写在这里免得后来人绕过：
 *   1. **先出计划，再执行**。计划带指纹，执行时重算一遍，对不上就整笔拒绝（零写入）。
 *   2. **写之前先备份**。备份里同时记"文件原件"和"改之前的服务状态"，否则回滚只能靠猜。
 *   3. **不装包**。目标机没有的插件一律跳过并如实计数——装包是 P2，混进来会让 P1 变得不可测。
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { hostname, userInfo } from 'node:os'
import { parseDocument } from 'yaml'
import { readManifest, verifyPack, hashText, toPosix } from './pack.js'
import { materializeLocalTarball } from './local-plugin.js'
import { readSessionIndex, listPackAttachments, applyPathMap, writeSession, writeAttachments } from './sessions.js'
import { projectKeyOf } from './session-log.js'
import { packHasSecrets, readSecretsRaw, decryptSecrets, applySecrets } from './secrets.js'
import { listPackPluginDataAreas, applyPluginData } from './plugin-data.js'
import { resolveDshVersion } from './env.js'
import { existsSync } from 'node:fs'
import { readProfileManifest } from './env.js'
import { readTextFile } from './export.js'

const PLAN_KIND = 'soul-plan/1'
const PLAN_TOKEN_PREFIX = 'soul1.'

/**
 * 计划要绑定到哪一台机器、哪一个档案（2026-11-20 真机事故）。
 *
 * 只比较变更清单不够：两台同名档案可以算出同一份清单，package.json 的改动也未必
 * 影响清单。把身份与修订号放进计划凭据，执行前才能明确说出"哪里变了"，并零写入拒绝。
 */
export function targetBindingOf(home, profile) {
  const profilePath = resolve(home, 'profiles', profile)
  let packageHash = 'missing'
  try {
    packageHash = hashText(readFileSync(join(profilePath, 'package.json'), 'utf8'))
  } catch {
    // 读不到也绑定成明确状态；执行前仍读不到才相同，恢复或换文件都会被认出。
  }
  let username = process.env.USERNAME || process.env.USER || 'unknown'
  let machine = process.env.COMPUTERNAME || 'unknown'
  try { username = userInfo().username || username } catch { /* 系统账号读不到时保留环境变量。 */ }
  try { machine = hostname() || machine } catch { /* 机器名读不到时保留环境变量。 */ }
  return { hostname: machine, username, profilePath: toPosix(profilePath), packageHash }
}

/** planId 是不透明凭据：可解码出原计划绑定，执行时仍会重算整份计划并逐字比对。 */
function makePlanId(items, targetBinding) {
  const payload = Buffer.from(JSON.stringify({ fingerprint: fingerprintOf(items), targetBinding }), 'utf8').toString('base64url')
  return `${PLAN_TOKEN_PREFIX}${payload}`
}

function bindingFromPlanId(planId) {
  if (typeof planId !== 'string' || !planId.startsWith(PLAN_TOKEN_PREFIX)) return null
  try {
    const parsed = JSON.parse(Buffer.from(planId.slice(PLAN_TOKEN_PREFIX.length), 'base64url').toString('utf8'))
    return parsed?.targetBinding && typeof parsed.targetBinding === 'object' ? parsed.targetBinding : null
  } catch {
    return null
  }
}

function targetBindingDiffs(before, now) {
  const labels = { hostname: '机器名', username: '用户名', profilePath: '档案绝对路径', packageHash: '档案修订号（package.json 哈希）' }
  const diffs = []
  for (const key of Object.keys(labels)) {
    if (before?.[key] !== now?.[key]) diffs.push(`${labels[key]}：${before?.[key] ?? '未知'} → ${now?.[key] ?? '未知'}`)
  }
  return diffs
}

/**
 * 按 YAML 结构读取插件行的 id/name，而不是猜缩进或相邻行。
 *
 * 补丁允许流程映射、字段换序和 `!!js` 表达式。前两者用正则必然漏检，后者无法安全确认；
 * 所以解析报错或结构不认识一律失败关闭，让对应层跳过，不能拿不确定的引用去覆盖文件。
 */
function patchPluginReferences(text) {
  try {
    const doc = parseDocument(String(text || ''), { strict: true, uniqueKeys: true })
    if (doc.errors.length > 0) return { ok: false, reason: doc.errors[0].message.split('\n')[0] }
    const root = doc.toJS()
    if (root === null || root === undefined) return { ok: true, refs: [] }
    if (!Array.isArray(root)) return { ok: false, reason: '顶层不是插件条目数组' }
    const refs = new Set()
    const visit = (rows) => {
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('插件条目不是映射')
        if (row.id !== undefined && (typeof row.id !== 'string' || !row.id)) throw new Error('插件 id 不是非空字符串')
        if (row.name !== undefined && (typeof row.name !== 'string' || !row.name)) throw new Error('插件 name 不是非空字符串')
        const pseudo = typeof row.name === 'string' && row.name.startsWith('cordis:')
        if (row.id && !pseudo) refs.add(row.id)
        if (row.name && !pseudo) refs.add(row.name)
        if (row.insert !== undefined) {
          if (!Array.isArray(row.insert)) throw new Error('insert 不是条目数组')
          visit(row.insert)
        }
        if (row.group === true && row.config !== undefined) {
          if (!Array.isArray(row.config)) throw new Error('插件组 config 不是条目数组')
          visit(row.config)
        }
      }
    }
    visit(root)
    return { ok: true, refs: [...refs] }
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err).split('\n')[0] }
  }
}

async function readJson(root, rel) {
  const text = await readTextFile(join(root, rel))
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 计划指纹：内容一变指纹就变，执行端据此拒绝"计划看过了但又变了"的情况。 */
export function fingerprintOf(items) {
  const canonical = JSON.stringify(
    items.map((i) => [i.id, i.action, i.target ?? '', i.detail ?? '']).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  )
  return hashText(`${PLAN_KIND}\n${canonical}`)
}

/**
 * 生成注入计划（只读）。
 *
 * @returns {Promise<object>} `{ ok, planId, items, summary }` 或 `{ ok:false, error }`
 */
export async function planSoul({ packDir, ctx, home, profile, pathMap = [], acceptPluginVersions = false, patch = false }) {
  const read = await readManifest(packDir)
  if (!read.ok) return { ok: false, error: read.error }
  const manifest = read.manifest

  const verify = await verifyPack(packDir)
  if (!verify.ok) {
    return { ok: false, error: `这个包校验不过，不能注入：${verify.problems.slice(0, 3).join('；')}` }
  }

  const sourceProfile = manifest?.source?.profile ?? null
  const targetProfile = profile || sourceProfile
  if (!targetProfile) return { ok: false, error: '包里没写来源档案名，请显式指定目标档案' }
  const targetBinding = targetBindingOf(home, targetProfile)

  // ── 版本门禁（2026-11-19 用户提出）──
  //
  // 结构层搬的是"给某个 DSH 版本配好的插件组合与补丁"。跨版本注入不是"少搬一点"，
  // 而是可能把本机的 DSH 本体弄坏，而且**不可逆**（插件组合、补丁层、配置命名空间
  // 都可能对不上）。所以这里默认拒绝，什么都不写，也不给"部分注入"。
  //
  // 两边有一边读不出版本时**不拦**：DSH 版本拿不到是探测的局限，不该因此禁止用户做事。
  const liveDshVersion = await resolveDshVersion(ctx)
  const packDshVersion = manifest?.source?.dshVersion ?? 'unknown'
  const liveNodeMajor = Number(String(process.version).replace(/^v/, '').split('.')[0]) || 0
  const packNodeMajor = Number(String(manifest?.source?.nodeVersion ?? '').replace(/^v/, '').split('.')[0]) || 0
  const nodeMismatch = liveNodeMajor > 0 && packNodeMajor > 0 && liveNodeMajor !== packNodeMajor
  if (liveDshVersion !== 'unknown' && packDshVersion !== 'unknown' && packDshVersion !== liveDshVersion || nodeMismatch) {
    const parts = []
    if (liveDshVersion !== 'unknown' && packDshVersion !== 'unknown' && packDshVersion !== liveDshVersion) {
      parts.push(`DSH 版本：包 ${packDshVersion}，本机 ${liveDshVersion}`)
    }
    if (nodeMismatch) {
      parts.push(`Node 大版本：包 v${packNodeMajor}，本机 v${liveNodeMajor}`)
    }
    const blocked = {
      sourceVersion: packDshVersion,
      liveVersion: liveDshVersion,
      sourceNodeMajor: packNodeMajor || null,
      liveNodeMajor: liveNodeMajor || null,
      reason:
        `运行环境不一致（${parts.join('；')}）。`
        + '跨环境注入可能损坏本机的 DSH，已拒绝执行（没有写入任何东西）。'
        + '请先把两台机器统一到同一个 DSH 版本与 Node 大版本，再重新体检。',
    }
    const plan = {
      kind: PLAN_KIND,
      packDir: toPosix(packDir),
      targetProfile,
      targetBinding,
      sourceDshVersion: packDshVersion,
      items: [],
      blocked,
      createdAt: new Date().toISOString(),
    }
    plan.planId = makePlanId([], targetBinding)
    return { ok: true, plan, planId: plan.planId, summary: countActions([]), blocked }
  }

  const items = []

  // ── 目标机的构建脚本：不批准的话，依赖它们的插件会因为 pnpm 报错而装不上 ──
  const pendingBuilds = pendingAllowBuilds(home, targetProfile)
  if (pendingBuilds.length > 0) {
    items.push({
      id: 'builds:pending',
      kind: 'builds',
      action: 'approve',
      target: '',
      detail:
        `目标机有 ${pendingBuilds.length} 个依赖的构建脚本还没批准（${pendingBuilds.map((x) => x.raw).join('、')}）：`
        + '不批准时相关插件会被 pnpm 拒绝安装、装上了也会被回滚。确认执行时会一并批准。',
    })
  }

  // ── 结构层 ──
  const pluginManager = ctx?.get?.('pluginManager')
  const liveBundles = (await pluginManager?.listBundles?.()) || []
  const liveByName = new Map((liveBundles || []).map((b) => [b?.name, b]))
  const bundlesFile = await readJson(packDir, 'profile/bundles.json')
  const pluginVersionDiffs = []
  for (const item of Array.isArray(bundlesFile?.bundles) ? bundlesFile.bundles : []) {
    if (!item || typeof item.name !== 'string') continue
    const live = liveByName.get(item.name)
    const id = `bundle:${item.name}`
    if (!live || live.installed === false) {
      // 目标机没装：能拿到安装源就装，拿不到就如实跳过——不要假装装得上去。
      if (typeof item.spec === 'string' && item.spec) {
        items.push({
          id,
          kind: 'install',
          action: 'install',
          target: item.name,
          spec: item.spec,
          localTarball: typeof item.localTarball === 'string' ? item.localTarball : null,
          detail: item.localTarball
            ? `安装本地插件 ${item.name}（用包里带的 tarball）`
            : `安装 ${item.spec}${item.version ? `（源机器上是 ${item.version}）` : ''}`,
        })
      } else {
        items.push({
          id,
          kind: 'bundle',
          action: 'skip',
          target: item.name,
          detail: '目标机没装，而且包里没记下可用的安装源，跳过',
        })
      }
      continue
    }
    const sourceVersion = typeof item.version === 'string' ? item.version : null
    const liveVersion = typeof live.version === 'string' ? live.version : null
    if (sourceVersion && liveVersion && sourceVersion !== liveVersion) {
      /**
       * **撞名策略：只升不降**（2026-11-20 用户提出）。
       *
       * 源机器比目标机新 → 升级，先卸再装（官方规定不能直接覆盖）。
       * 源机器比目标机旧 → **保留目标机**，并写清为什么跳过。
       *   降级会丢功能，还可能让插件的私有数据对不上版本；这类"没人要求过的倒退"
       *   不该由搬家替用户决定。
       */
      const newer = comparePluginVersions(sourceVersion, liveVersion) > 0
      // 只有"要升级"的才进软门禁：降级是**跳过**，不涉及改动，不必让人确认。
      if (newer) pluginVersionDiffs.push({ name: item.name, source: sourceVersion, live: liveVersion })
      if (!newer) {
        items.push({
          id,
          kind: 'bundle',
          action: 'skip',
          target: item.name,
          detail: `目标机是 ${liveVersion}，比源机器的 ${sourceVersion} 更新，保留不动（不降级）`,
        })
        continue
      }
      items.push({
        id,
        kind: 'install',
        action: 'reinstall',
        target: item.name,
        spec: item.spec || `${item.name}@${sourceVersion}`,
        oldVersion: liveVersion,
        detail: `升级 ${liveVersion} → ${sourceVersion}；先卸再装（官方规定不能直接覆盖）`,
      })
      continue
    }
    if (live.enabled === false) {
      items.push({
        id,
        kind: 'bundle',
        action: 'enable',
        target: item.name,
        detail: `启用 ${item.name}${item.version ? ` ${item.version}` : ''}`,
      })
    } else {
      items.push({ id, kind: 'bundle', action: 'noop', target: item.name, detail: '已启用，无需改动' })
    }
  }

  // ── 软门禁：插件版本差异 ──
  //
  // 计划里本来就有"先卸再装"这条路，版本不同不是必然出事。但**装不上的后果很重**：
  // 目标机会缺一个插件，而插件组合是 DSH 启动时要读的，缺了可能起不来。
  // 所以默认也拦，人看清楚之后可以用一次显式确认放行。
  if (pluginVersionDiffs.length > 0 && acceptPluginVersions !== true) {
    const list = pluginVersionDiffs
      .slice(0, 8)
      .map((d) => `${d.name}（包 ${d.source} / 本机 ${d.live}）`)
      .join('、')
    const blocked = {
      soft: true,
      pluginVersionDiffs,
      reason:
        `有 ${pluginVersionDiffs.length} 个插件的版本与本机不同：${list}${pluginVersionDiffs.length > 8 ? ' 等' : ''}。`
        + '按源版本重装时，装不上会让本机缺插件（DSH 可能起不来）。'
        + '确认可以按源版本重装，再继续。',
    }
    const plan = {
      kind: PLAN_KIND,
      packDir: toPosix(packDir),
      targetProfile,
      targetBinding,
      sourceDshVersion: packDshVersion,
      items: [],
      blocked,
      createdAt: new Date().toISOString(),
    }
    plan.planId = makePlanId([], targetBinding)
    return { ok: true, plan, planId: plan.planId, summary: countActions([]), blocked }
  }

  // ── 配置层：settings ──
  const settings = ctx?.get?.('settings')
  const settingsFile = await readJson(packDir, 'settings/namespaces.json')
  const sourceNamespaces = settingsFile?.namespaces && typeof settingsFile.namespaces === 'object'
    ? settingsFile.namespaces
    : {}
  if (settingsFile?.unavailable) {
    items.push({
      id: 'settings:unavailable',
      kind: 'settings',
      action: 'skip',
      target: '',
      detail: `导出时就没读到配置：${settingsFile.reason || '原因未记录'}`,
    })
  } else if (!settings) {
    items.push({
      id: 'settings:no-service',
      kind: 'settings',
      action: 'skip',
      target: '',
      detail: '这台 DSH 没有 settings 服务，配置无法写入',
    })
  } else {
    let live = null
    if (typeof settings.describeAll === 'function') {
      try {
        const all = await settings.describeAll.call(settings, { redactSecrets: true })
        live = new Map((all || []).map((e) => [e?.ns, e?.info]))
      } catch {
        live = null
      }
    }
    for (const [ns, payload] of Object.entries(sourceNamespaces)) {
      const id = `settings:${ns}`
      if (!live) {
        items.push({
          id,
          kind: 'settings',
          action: 'skip',
          target: ns,
          detail: '读不到目标机的配置清单，不敢盲写',
        })
        continue
      }
      const current = live.get(ns)
      if (!current) {
        // 官方口径：settings 的 namespace 就是 profile 条目 id，条目不在就写不进去。
        items.push({
          id,
          kind: 'settings',
          action: 'skip',
          target: ns,
          detail: '目标机没有这个配置条目（对应插件没装或没启用），跳过',
        })
        continue
      }
      const same = JSON.stringify(current.value ?? null) === JSON.stringify(payload?.value ?? null)
      items.push({
        id,
        kind: 'settings',
        action: same ? 'noop' : 'replace',
        target: ns,
        detail: same ? '值相同，无需改动' : '用包里的值替换目标机的生效配置',
      })
    }
  }

  // ── 配置层：两层 patch ──
  //
  // 默认**完全不搬**（2026-11-20 真机事故）：官方语义是整份替换而非深合并，
  // 把 A 的补丁写过去会同时抹掉 B 的自有补丁。确需搬运时，计划与执行都要显式传
  // `patch: true`，并先核对引用；目标机不存在的插件不能让该文件进入执行队列。
  if (patch === true) {
    const patchPairs = [
      ['home', 'profile/patches/home.cordis.patch.yml', join(home, 'cordis.patch.yml')],
      ['profile', 'profile/patches/profile.cordis.patch.yml', join(home, 'profiles', targetProfile, 'cordis.patch.yml')],
    ]
    const profileManifest = readProfileManifest(home, targetProfile)
    const targetRefs = new Set([
      ...profileManifest.bundles,
      ...Object.keys(profileManifest.dependencies || {}),
    ])
    for (const bundle of liveBundles || []) {
      if (bundle?.installed !== false && typeof bundle?.name === 'string') targetRefs.add(bundle.name)
    }
    // 目标机现有补丁里的 id 是已经存在的插件行；允许对它们做定向修改。
    for (const [, , dest] of patchPairs) {
      const current = await readTextFile(dest)
      if (current === null) continue
      const parsed = patchPluginReferences(current)
      if (parsed.ok) for (const ref of parsed.refs) targetRefs.add(ref)
    }
    for (const [layer, rel, dest] of patchPairs) {
      const source = await readTextFile(join(packDir, rel))
      if (source === null) continue
      const parsed = patchPluginReferences(source)
      const missing = parsed.ok ? parsed.refs.filter((ref) => !targetRefs.has(ref)) : []
      if (!parsed.ok || missing.length > 0) {
        const reason = parsed.ok
          ? `引用了目标机不存在的插件：${missing.join('、')}`
          : `无法可靠解析（${parsed.reason}）`
        items.push({
          id: `patch:${layer}`,
          kind: 'patch',
          action: 'skip',
          target: toPosix(dest),
          detail: `${layer} 层 patch ${reason}；此文件已跳过，目标机原文件不变`,
          source: rel,
          missingPlugins: missing,
          ...(parsed.ok ? {} : { parseError: parsed.reason }),
        })
        continue
      }
      const current = await readTextFile(dest)
      const same = current !== null && current === source
      items.push({
        id: `patch:${layer}`,
        kind: 'patch',
        action: same ? 'noop' : current === null ? 'create' : 'replace',
        target: toPosix(dest),
        detail: same ? '内容相同，无需改动' : `${layer} 层 patch 整份${current === null ? '新建' : '替换'}（替换前备份）`,
        source: rel,
      })
    }
  }

  // ── 自定义文件 ──
  const { listFilesDeep } = await import('./pack.js')
  const customRoot = join(packDir, 'custom')
  const skillRoot = join(packDir, 'custom/skills')
  const presetRoot = join(packDir, 'custom/agent-presets')
  const customFiles = await listFilesDeep(customRoot)
  for (const abs of customFiles) {
    const rel = toPosix(abs.slice(customRoot.length + 1))
    let destRel = null
    if (rel === 'AGENTS.md') destRel = 'AGENTS.md'
    else if (rel.startsWith('skills/')) destRel = rel
    else if (rel.startsWith('agent-presets/')) destRel = rel.replace('agent-presets/', '.agent-presets/')
    if (!destRel) continue
    const dest = join(home, destRel)
    const current = await readTextFile(dest)
    const source = await readTextFile(abs)
    const same = current !== null && current === source
    items.push({
      id: `file:${destRel}`,
      kind: 'file',
      action: same ? 'noop' : current === null ? 'create' : 'replace',
      target: toPosix(dest),
      detail: same ? '内容相同' : current === null ? '新增文件' : '覆盖同名文件（覆盖前备份）',
      // 源路径要相对**包根**，执行端才找得到；rel 是相对 custom/ 的。
      source: `custom/${rel}`,
    })
  }

  // ── 记忆层：会话与附件 ──
  const sessionIndex = await readSessionIndex(packDir)
  const packAttachments = await listPackAttachments(packDir)
  if (sessionIndex && sessionIndex.sessions.length > 0) {
    const liveVersion = await resolveDshVersion(ctx)
    const sourceVersion = manifest?.source?.dshVersion ?? 'unknown'
    // 本机版本读不出来（'unknown'）时**不能判成不同**：那会把会话白白跳过。
    if (liveVersion !== 'unknown' && sourceVersion !== 'unknown' && sourceVersion !== liveVersion) {
      items.push({
        id: 'sessions:version',
        kind: 'session',
        action: 'skip',
        target: '',
        detail: `两端 DSH 版本不同（包 ${sourceVersion} → 本机 ${liveVersion}），会话这次不搬：硬搬会得到读不出来的数据`,
      })
    } else {
      for (const entry of sessionIndex.sessions) {
        const mapped = typeof entry.cwd === 'string' ? applyPathMap(entry.cwd, pathMap) : null
        const key = (mapped && projectKeyOf(mapped)) || entry.projectKey
        const exists = existsSync(join(home, 'sessions', key, entry.sessionId))
        const changed = Boolean(mapped && entry.cwd && mapped !== entry.cwd)
        items.push({
          id: `session:${entry.sessionId}`,
          kind: 'session',
          action: exists ? 'skip' : 'create',
          target: `${key}/${entry.sessionId}`,
          detail: exists
            ? '目标机已有同 id 的会话，跳过（不覆盖）'
            : changed
              ? `导入会话，cwd 改写成 ${mapped}`
              : '导入会话',
          entry,
        })
      }
    }
  }
  if (packAttachments.length > 0) {
    items.push({
      id: 'attachments',
      kind: 'attachments',
      action: 'create',
      target: '',
      detail: `补齐 ${packAttachments.length} 个附件（内容寻址，已存在的自动跳过）`,
    })
  }

  // ── 插件私有数据（可选）──
  const pluginDataAreas = await listPackPluginDataAreas(packDir)
  if (pluginDataAreas.length > 0) {
    const totalBytes = pluginDataAreas.reduce((sum, a) => sum + (Number(a.bytes) || 0), 0)
    items.push({
      id: 'plugin-data',
      kind: 'plugin-data',
      action: 'create',
      target: '',
      detail: `补回 ${pluginDataAreas.length} 个插件的私有数据目录（共 ${Math.round(totalBytes / 1024 / 1024)} MB，已存在的文件不覆盖）`,
    })
  }

  // ── 凭据层：只有包里带了才出这一项；写不写得进去取决于执行时有没有给密码 ──
  if (await packHasSecrets(packDir)) {
    items.push({
      id: 'secrets',
      kind: 'secrets',
      action: 'replace',
      target: '',
      detail: '包里带了加密凭据；执行时需要在设置页输入密码才会写入（agent 拿不到密码）',
    })
  }

  const plan = {
    kind: PLAN_KIND,
    packDir: toPosix(packDir),
    targetProfile,
    targetBinding,
    sourceDshVersion: manifest?.source?.dshVersion ?? 'unknown',
    items,
    createdAt: new Date().toISOString(),
  }
  plan.planId = makePlanId(items, targetBinding)

  const summary = countActions(items)
  return { ok: true, plan, planId: plan.planId, summary }
}

/**
 * 比版本号：a 比 b 新返回正数。预发布低于同号正式版。
 *
 * 搬家时只用它回答一个问题：**源机器的版本是不是比目标机新**。
 * 是 → 升级；不是 → 保留目标机，绝不降级。
 */
/**
 * 目标机上「待决定的构建脚本」（2026-11-20 真机）。
 *
 * pnpm 会把这些依赖写成占位符：
 *   allowBuilds:
 *     cloudflared@0.7.3: set this to true or false
 * 没做决定，安装时报 ERR_PNPM_IGNORED_BUILDS，DSH 判失败并回滚依赖，
 * 于是"装一个撤一个"——用户只能看到一句空的 operation-error，看不出该改什么。
 */
export function pendingAllowBuilds(home, profile) {
  const file = join(home, 'profiles', profile, 'pnpm-workspace.yaml')
  let text = null
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{2}([\w@/.+-]+):\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const value = m[2]
    if (value !== 'true' && value !== 'false') {
      out.push({ raw: m[1], name: m[1].split('@')[0] })
    }
  }
  return out
}

/** 把待决定的项写成 true（改前备份）。返回真正改掉的名字。 */
export function approveAllowBuilds(home, profile, names = null) {
  const file = join(home, 'profiles', profile, 'pnpm-workspace.yaml')
  let text = null
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  const want = names ? new Set(names.map((n) => String(n).split('@')[0])) : null
  const changed = []
  const next = text.split(/\r?\n/).map((line) => {
    const m = /^(\s{2})([\w@/.+-]+):\s*(.+?)\s*$/.exec(line)
    if (!m) return line
    const value = m[3]
    if (value === 'true' || value === 'false') return line
    const name = m[2].split('@')[0]
    if (want && !want.has(name)) return line
    changed.push(m[2])
    return `${m[1]}${m[2]}: true`
  })
  if (changed.length === 0) return []
  copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`)
  writeFileSync(file, next.join('\n'), 'utf8')
  return changed
}

export function comparePluginVersions(a, b) {
  const split = (v) => {
    const [core, pre = ''] = String(v || '').trim().split('-')
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0)
    while (nums.length < 3) nums.push(0)
    return { nums, pre }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < 3; i += 1) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i]
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre > y.pre ? 1 : -1
}

export function countActions(items) {
  const summary = { install: 0, reinstall: 0, enable: 0, replace: 0, create: 0, noop: 0, skip: 0 }
  for (const item of items || []) {
    if (item.action in summary) summary[item.action] += 1
  }
  return summary
}

/**
 * 执行计划。**必须带 planId**；执行前会重算一次计划，指纹不符直接拒绝（零写入）。
 */
export async function applySoul({ packDir, ctx, home, profile, planId, confirm, pathMap = [], password = '', acceptPluginVersions = false, patch = false }) {
  if (confirm !== true) return { ok: false, error: '这一步会改配置和文件，需要明确确认（confirm: true）' }
  if (!planId) return { ok: false, error: '必须携带 soul_plan 返回的 planId；没有原计划的绑定信息就不能安全执行' }

  const fresh = await planSoul({ packDir, ctx, home, profile, pathMap, acceptPluginVersions, patch })
  if (!fresh.ok) return fresh
  const expectedBinding = bindingFromPlanId(planId)
  if (expectedBinding) {
    const differences = targetBindingDiffs(expectedBinding, fresh.plan.targetBinding)
    if (differences.length > 0) {
      return {
        ok: false,
        code: 'target-mismatch',
        differences,
        error: `计划绑定的目标已经变化，已零写入拒绝：${differences.join('；')}。请确认当前连接的是哪台电脑，再重新生成计划。`,
      }
    }
  }
  if (planId !== fresh.planId) {
    return {
      ok: false,
      error: `计划已经变了（可能包被替换或目标机状态变了）。重新看一眼计划再执行。当前 planId=${fresh.planId}`,
    }
  }
  const effective = fresh.plan
  const targetBinding = effective.targetBinding
  if (effective.blocked) {
    return { ok: false, error: effective.blocked.reason, blocked: effective.blocked, planId: fresh.planId }
  }
  const notes = effective.items
    .filter((i) => i.kind === 'patch' && i.action === 'skip')
    .map((i) => i.detail)
  const work = effective.items.filter((i) => i.action !== 'noop' && i.action !== 'skip')
  if (work.length === 0) {
    return { ok: true, changed: false, planId: fresh.planId, summary: fresh.summary, journal: [], notes: [...notes, '没有需要改的东西'] }
  }

  const snapshotDir = await createSnapshotDirectory(home)
  const journal = []

  // 顺序固定：先结构（启用插件），再配置（settings），最后文件（patch / 自定义）。
  // 反过来做的话，配置可能写进一个"还没启用"的条目而失败。
  const order = { install: 0, bundle: 1, settings: 2, patch: 3, file: 4, pluginData: 5, attachments: 6, session: 7, secrets: 8 }
  const queue = [...work].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9))

  for (const item of queue) {
    try {
      if (item.kind === 'install') {
        const pluginManager = ctx?.get?.('pluginManager')
        if (!pluginManager?.installBundle) {
          notes.push(`跳过安装 ${item.target}：这台 DSH 没有 pluginManager`)
          journal.push({ ...item, result: 'skipped' })
          continue
        }
        // reinstall 必须先删：官方规定 installBundle 命中已安装包会直接失败，
        // 删除会停掉该 bundle 的插件并清掉包映射，再装才会真的换版本。
        if (item.action === 'reinstall') {
          if (!pluginManager.removeBundle) {
            notes.push(`跳过 ${item.target}：没有 removeBundle，无法换版本`)
            journal.push({ ...item, result: 'skipped' })
            continue
          }
          await pluginManager.removeBundle(item.target)
          // 回滚时把旧版本装回去（尽力而为，装不回也如实记）。
          await record(snapshotDir, { kind: 'bundle-version', target: item.target, oldSpec: `${item.target}@${item.oldVersion ?? ''}`, profilePath: targetBinding.profilePath })
        } else {
          // 新装的包：回滚时卸掉；档案路径让带外脚本不必猜测该改哪个 package.json。
          await record(snapshotDir, { kind: 'bundle-install', target: item.target, profilePath: targetBinding.profilePath })
        }
        let spec = item.spec
        if (item.localTarball) {
          // 包里的 tarball 要先落到本机，`file:` 才能被包管理器解析；临时目录不行，
          // 那会写进一条指向易失路径的持久依赖。
          const abs = await materializeLocalTarball({
            packDir,
            rel: item.localTarball,
            home,
            name: item.target,
          })
          spec = `file:${abs}`
        }
        const res = await pluginManager.installBundle(spec)
        if (res?.application === 'failed') {
          const code = res?.error?.code ?? 'unknown'
          // already-installed 不算失败：目标机本来就有，继续往下启用即可。
          if (code === 'already-installed') {
            journal.push({ ...item, result: 'skipped', error: '目标机已经有了，跳过安装' })
            notes.push(`${item.target} 目标机已安装，跳过安装`)
          } else {
            /**
             * 「报错但装上了」这一种要认清（2026-11-20 真机）。
             *
             * pnpm 遇到不允许执行构建脚本的依赖会给出 ERR_PNPM_IGNORED_BUILDS，
             * DSH 把它算成 operation-error；可包其实已经装好了。
             * 早先照着"失败"去 removeBundle，等于把刚装好的又拆掉，
             * 下一笔安装顺手把它的依赖也清了——表现就是"有些插件没同步过去"。
             *
             * 所以以**事实**为准：装完再问一次它到底在不在。
             */
            const after = (await pluginManager.listBundles?.())?.find((b) => b?.name === item.target)
            if (after && after.installed !== false) {
              journal.push({ ...item, result: 'applied', error: `${code}: 包已装上，有一项构建脚本被跳过` })
              notes.push(`${item.target} 装好了；其中某个依赖的构建脚本被 pnpm 跳过（不影响使用，需要时可在目标机批准）`)
              continue
            }
            journal.push({ ...item, result: 'failed', error: `${code}: ${res?.error?.message ?? ''}` })
            // 说得出原因才叫报错：把"哪些构建脚本待批准"直接点名。
            const waits = pendingAllowBuilds(home, targetProfile)
            if (waits.length > 0) {
              notes.push(
                `${item.target} 装不上：目标机有 ${waits.length} 个依赖的构建脚本还没批准`
                + `（${waits.map((x) => x.raw).join('、')}）。批准后重试即可。`,
              )
            }
            // 装失败也要**把它从启用清单里摘掉**：有的实现会先登记再下载，
            // 留下一条"启用了但没装"的记录，DSH 下次启动就会在那里断掉（2026-11-20 事故）。
            try {
              await pluginManager.removeBundle?.(item.target)
              notes.push(`${item.target} 安装失败（${code}），已从启用清单摘掉`)
            } catch {
              notes.push(`${item.target} 安装失败（${code}），且没能从启用清单里摘掉，请手动检查`)
            }
          }
          continue
        }
        journal.push({ ...item, result: 'applied' })
        if (res?.application === 'restart-required') notes.push(`${item.target} 装好了，需要重启 DSH 才生效`)
        continue
      }

      if (item.kind === 'builds') {
        const changed = approveAllowBuilds(home, targetProfile)
        journal.push({ ...item, result: changed.length ? 'applied' : 'skipped', error: changed.join(',') })
        if (changed.length) notes.push(`已批准构建脚本：${changed.join('、')}`)
        continue
      }

      if (item.kind === 'bundle') {
        const pluginManager = ctx?.get?.('pluginManager')
        if (!pluginManager?.setBundleEnabled) {
          notes.push(`跳过 ${item.target}：这台 DSH 没有 pluginManager，改不了 bundle 启用状态`)
          journal.push({ ...item, result: 'skipped' })
          continue
        }
        const before = (await pluginManager.listBundles?.())?.find((b) => b?.name === item.target)
        // **必须在装好之后才允许启用**（2026-11-20 真机事故）：
        // 把"目标机上其实没有的包"写进启用清单，DSH 启动时会在它那里断掉，
        // 后续插件（包括本插件）的宿主路由都挂不上——表现是设置页一片 404。
        if (!before || before.installed === false) {
          notes.push(`跳过 ${item.target}：这台机器上没装这个包，写进启用清单会让 DSH 起不来`)
          journal.push({ ...item, result: 'skipped', error: 'not-installed' })
          continue
        }
        await record(snapshotDir, { kind: 'bundle', target: item.target, oldEnabled: before?.enabled === true })
        const res = await pluginManager.setBundleEnabled(item.target, true)
        journal.push({ ...item, result: res?.application ?? 'applied' })
        if (res?.application === 'restart-required') notes.push(`${item.target} 需要重启 DSH 才生效`)
        continue
      }

      if (item.kind === 'settings') {
        const settings = ctx?.get?.('settings')
        const packSettings = await readJson(packDir, 'settings/namespaces.json')
        const payload = packSettings?.namespaces?.[item.target]
        if (!settings?.replace || !payload) {
          notes.push(`跳过配置 ${item.target}：缺少可写入的值或服务`)
          journal.push({ ...item, result: 'skipped' })
          continue
        }
        // 现读一次 revision：拿旧计划里的 revision 去写必然被拒。
        const all = typeof settings.describeAll === 'function'
          ? await settings.describeAll.call(settings, { redactSecrets: true })
          : []
        const current = (all || []).find((e) => e?.ns === item.target)?.info
        if (!current) {
          notes.push(`跳过配置 ${item.target}：目标机现在没有这个条目`)
          journal.push({ ...item, result: 'skipped' })
          continue
        }
        await record(snapshotDir, {
          kind: 'settings',
          target: item.target,
          oldValue: current.value ?? null,
        })
        await settings.replace(item.target, payload.value, current.revision)
        journal.push({ ...item, result: 'applied' })
        continue
      }

      if (item.kind === 'plugin-data') {
        const done = await applyPluginData({ packDir })
        for (const abs of done.added) await record(snapshotDir, { kind: 'file', target: abs, backup: null })
        journal.push({
          ...item,
          result: done.added.length > 0 ? 'applied' : 'skipped',
          detail: `新增 ${done.added.length} 个文件，已存在跳过 ${done.skipped} 个`,
        })
        continue
      }

      if (item.kind === 'secrets') {
        if (!password) {
          notes.push('包里带了凭据，但没有提供密码，凭据没有写入')
          journal.push({ ...item, result: 'skipped', detail: '未提供密码' })
          continue
        }
        let entries
        try {
          entries = decryptSecrets(await readSecretsRaw(packDir), password)
        } catch (err) {
          // 密码不对或文件被动过：**不写任何一条**，并让它成为硬失败。
          journal.push({ ...item, result: 'failed', error: String(err?.message ?? err) })
          notes.push(`凭据没有写入：${err?.message ?? err}`)
          continue
        }
        const done = await applySecrets(ctx, entries)
        if (!done.written.length && done.reason) {
          journal.push({ ...item, result: 'failed', error: done.reason })
          notes.push(`凭据没有写入：${done.reason}`)
          continue
        }
        journal.push({
          ...item,
          result: done.failed.length === 0 ? 'applied' : 'failed',
          detail: `写入 ${done.written.length} 条${done.failed.length ? `，失败 ${done.failed.length} 条` : ''}`,
        })
        if (done.failed.length > 0) {
          notes.push(`这些凭据没写进去：${done.failed.map((f) => f.ref).join('、')}`)
        }
        notes.push('凭据无法自动回滚：回滚不会把旧密钥还原，需要你自己重新填')
        continue
      }

      if (item.kind === 'attachments') {
        const result = await writeAttachments({ packDir, home })
        for (const abs of result.added) await record(snapshotDir, { kind: 'file', target: abs, backup: null })
        journal.push({ ...item, result: result.added.length > 0 ? 'applied' : 'skipped', detail: `新增 ${result.added.length} 个，已有 ${result.skipped} 个` })
        continue
      }

      if (item.kind === 'session') {
        const result = await writeSession({ packDir, home, entry: item.entry, maps: pathMap })
        for (const abs of result.added || []) await record(snapshotDir, { kind: 'file', target: abs, backup: null })
        if (result.ok) journal.push({ ...item, result: 'applied' })
        else journal.push({ ...item, result: 'failed', error: result.reason })
        if (!result.ok) notes.push(`${item.target}：${result.reason}`)
        continue
      }

      // patch 与自定义文件都是"整份写入"，先备份再写。
      const source = await readTextFile(join(packDir, item.source))
      if (source === null) {
        notes.push(`跳过 ${item.target}：包里的源文件不见了`)
        journal.push({ ...item, result: 'skipped' })
        continue
      }
      await mkdir(dirname(item.target), { recursive: true })
      const existed = await readTextFile(item.target)
      if (existed !== null) {
        await record(snapshotDir, { kind: 'file', target: item.target, backup: await backupFile(snapshotDir, item.target) })
      } else {
        await record(snapshotDir, { kind: 'file', target: item.target, backup: null })
      }
      await writeFile(item.target, source, 'utf8')
      journal.push({ ...item, result: 'applied' })
    } catch (err) {
      journal.push({ ...item, result: 'failed', error: String(err?.message ?? err) })
      notes.push(`${item.target} 失败：${err?.message ?? err}`)
    }
  }

  const failed = journal.filter((j) => j.result === 'failed')
  // 注意：**不要覆盖 `journal.json`**。那份是"回滚凭据"（记原件与旧值），
  // 这里写的是"这次做了什么"，放 `result.json`，两者混在一起会让回滚读不到备份。
  await writeFile(join(snapshotDir, 'result.json'), `${JSON.stringify({
    planId: fresh.planId,
    targetBinding,
    journal,
    notes,
  }, null, 2)}\n`, 'utf8')

  return {
    ok: failed.length === 0,
    changed: journal.some((j) => j.result === 'applied'),
    planId: fresh.planId,
    snapshotDir: toPosix(snapshotDir),
    summary: fresh.summary,
    journal,
    notes,
    failed: failed.length,
    offlineRollback: {
      script: 'scripts/soul-offline-rollback.mjs',
      command: `node scripts/soul-offline-rollback.mjs "${toPosix(snapshotDir)}"`,
    },
    // 回滚入口把快照目录交出去，用户不必自己去找。
    hint: failed.length === 0
      ? '有需要重启的项就重启 DSH；不满意可以用 soul_rollback 回到这次之前。若插件已经打不开，在插件包根目录执行 offlineRollback.command。'
      : '有项失败，可用 soul_rollback 整笔退回；插件打不开时，在插件包根目录执行 offlineRollback.command。',
  }
}

async function createSnapshotDirectory(home) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const dir = join(home, 'dsh-everywhere', 'souls', '.snapshots', stamp)
  await mkdir(dir, { recursive: true })
  return dir
}

async function record(snapshotDir, entry) {
  const file = join(snapshotDir, 'journal.json')
  let data = { entries: [] }
  try {
    data = JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(data.entries)) data.entries = []
  } catch {
    // 第一次写。
  }
  data.entries.push(entry)
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

async function backupFile(snapshotDir, target) {
  const name = hashText(target).slice(0, 16)
  const dest = join(snapshotDir, 'files', name)
  await mkdir(dirname(dest), { recursive: true })
  await cp(target, dest)
  return toPosix(dest)
}

/** 回滚：把快照里记的东西退回去。文件按备份还原，服务状态按记录改回。 */
export async function rollbackSoul({ ctx, snapshotDir }) {
  let data
  try {
    data = JSON.parse(await readFile(join(snapshotDir, 'journal.json'), 'utf8'))
  } catch (err) {
    return { ok: false, error: `读不到快照记录（${err?.message ?? err}）` }
  }
  const entries = Array.isArray(data.entries) ? data.entries : []
  const done = []
  const failed = []
  // 逆序退：后做的先撤，谁也别踩谁。
  for (const entry of [...entries].reverse()) {
    try {
      if (entry.kind === 'file') {
        if (entry.backup) await cp(entry.backup, entry.target)
        else await rm(entry.target, { force: true })
        done.push(`文件 ${entry.target}`)
      } else if (entry.kind === 'settings') {
        const settings = ctx?.get?.('settings')
        if (!settings?.replace) throw new Error('没有 settings 服务')
        const all = typeof settings.describeAll === 'function'
          ? await settings.describeAll.call(settings, { redactSecrets: true })
          : []
        const current = (all || []).find((e) => e?.ns === entry.target)?.info
        if (!current) throw new Error('这个配置条目现在不存在了')
        await settings.replace(entry.target, entry.oldValue, current.revision)
        done.push(`配置 ${entry.target}`)
      } else if (entry.kind === 'bundle-install') {
        const pluginManager = ctx?.get?.('pluginManager')
        if (!pluginManager?.removeBundle) throw new Error('没有 removeBundle')
        await pluginManager.removeBundle(entry.target)
        done.push(`卸载本次新装的 ${entry.target}`)
      } else if (entry.kind === 'bundle-version') {
        const pluginManager = ctx?.get?.('pluginManager')
        if (!pluginManager?.installBundle || !entry.oldSpec || entry.oldSpec.endsWith('@')) {
          throw new Error('没有记下旧版本，装不回去')
        }
        const res = await pluginManager.installBundle(entry.oldSpec)
        if (res?.application === 'failed') throw new Error(res?.error?.code ?? 'install failed')
        done.push(`把 ${entry.target} 装回 ${entry.oldSpec}`)
      } else if (entry.kind === 'bundle') {
        const pluginManager = ctx?.get?.('pluginManager')
        if (!pluginManager?.setBundleEnabled) throw new Error('没有 pluginManager')
        await pluginManager.setBundleEnabled(entry.target, entry.oldEnabled === true)
        done.push(`插件 ${entry.target}（启用状态改回 ${entry.oldEnabled === true}）`)
      }
    } catch (err) {
      failed.push(`${entry.target ?? entry.kind}：${err?.message ?? err}`)
    }
  }
  return { ok: failed.length === 0, restored: done, failed }
}
