/**
 * 移魂的 HTTP 入口（设置页面板用）。
 *
 * 为什么要有这一层：模型的工具只在会话里可用，而设置页是用户自己去点的地方，
 * 两者够不着。所以同一套能力开两条门——工具给模型，路由给界面，实现是同一份。
 *
 * 安全：五条都走 `localOnly`（和其余 `/mini-remote/*` 一样只认同机），
 * 且写入的两条（apply / rollback）要求请求体里带 `confirm: true`，
 * 不靠界面"点两下"当保险。
 */
import { detectProfile, resolveHome } from './env.js'
import { exportSoul, defaultExportDir } from './export.js'
import { inspectSoul } from './inspect.js'
import { planSoul, applySoul, rollbackSoul, pendingAllowBuilds, approveAllowBuilds } from './migrate.js'
import { readManifest } from './pack.js'
import { execFile } from 'node:child_process'
import { listRoots, listDirectory } from '../browse.js'
import { inspectTarget, pushToDir, pullFromDir, compareWithDir, adoptSnapshot, snapshotId, resolveSyncRoot, SNAPSHOT_DIR } from './dir-sync.js'
import { readPrefs, writePrefs } from './prefs.js'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { resolve as resolvePath, sep, dirname } from 'node:path'

export function registerSoulRoutes({ ctx, mountRoute, localOnly, readBody, sendJson, log }) {
  const home = resolveHome()
  const disposers = []

  const post = (path, run) => {
    disposers.push(
      mountRoute({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          if (!localOnly(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
            return
          }
          let body
          try {
            body = await readBody(req)
          } catch (err) {
            sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
            return
          }
          try {
            const { status, payload } = await run(body || {})
            sendJson(res, status, payload)
          } catch (err) {
            log?.warn?.(`移魂接口 ${path} 出错：${err?.message ?? err}`)
            sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
          }
        },
      }),
    )
  }

  /** GET 版：参数走查询串。 */
  const get = (path, run) => {
    disposers.push(
      mountRoute({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          if (!localOnly(req, res)) return
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: '这个地址只接受 GET。' })
            return
          }
          try {
            const { status, payload } = await run(req)
            sendJson(res, status, payload)
          } catch (err) {
            log?.warn?.(`移魂接口 ${path} 出错：${err?.message ?? err}`)
            sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
          }
        },
      }),
    )
  }

  /**
   * 弹**系统自带**的文件夹选择框。
   *
   * 这是本机场景下唯一对的交互：用户就坐在电脑前，点一下就该出来 Windows 的对话框，
   * 而不是在网页里一层层点目录（2026-11-17 用户指出）。
   *
   * 能不能弹由宿主决定：`ctx.directoryPicker.capability()` 返回 `native` 才有 `pick()`；
   * 返回 `browse`（例如 DSH 跑在远端或 SSH 里）时如实回 `kind: 'browse'`，
   * 让界面退回自己的列表——**不要假装弹了**。
   */
  post('/mini-remote/soul/pick-folder', async () => {
    const picker = ctx?.get?.('directoryPicker')
    if (!picker || typeof picker.capability !== 'function') {
      return { status: 200, payload: { ok: false, kind: 'none', reason: '这台 DSH 没有目录选择服务' } }
    }
    let capability
    try {
      capability = picker.capability()
    } catch (err) {
      return { status: 200, payload: { ok: false, kind: 'none', reason: String(err?.message ?? err) } }
    }
    if (!capability || capability.kind !== 'native' || typeof capability.pick !== 'function') {
      return { status: 200, payload: { ok: false, kind: 'browse', reason: '这台 DSH 只能提供目录列表' } }
    }
    try {
      // 用户可能翻很久，给足两分钟；超时按"没选"处理，不报错吓人。
      const chosen = await capability.pick(AbortSignal.timeout(120_000))
      return { status: 200, payload: { ok: true, kind: 'native', path: chosen || '' } }
    } catch (err) {
      return { status: 200, payload: { ok: false, kind: 'native', reason: String(err?.message ?? err) } }
    }
  })

  // 选包的目录浏览：**只给设置页用**，只认同机。列目录直接读盘——浏览器没有可用的
  // 目录选择器（DSH 桌面端也一样），所以这一层必须由宿主提供。
  get('/mini-remote/soul/browse-roots', async () => {
    const { home, drives } = await listRoots({ recent: [] })
    const roots = []
    if (home) roots.push({ label: '这台电脑的用户目录', path: home })
    for (const drive of drives || []) roots.push({ label: drive, path: drive })
    return { status: 200, payload: { ok: true, roots } }
  })

  get('/mini-remote/soul/browse-list', async (req) => {
    const asked = new URL(req.url ?? '/', 'http://placeholder').searchParams.get('path')
    if (!asked) return { status: 400, payload: { ok: false, error: '要带 path 参数。' } }
    const result = await listDirectory(asked)
    if (!result.ok) {
      const said = result.reason === 'bad-path'
        ? '这个路径不合法。'
        : result.reason === 'unavailable'
          ? '这台电脑上的 DSH 没提供目录浏览。'
          : `读不到这个目录（${result.error ?? '原因未知'}），可能不存在或没有权限。`
      return { status: result.reason === 'bad-path' ? 400 : 404, payload: { ok: false, error: said } }
    }
    // 界面只要"能进的子目录"，不列文件——移魂包是一个目录，用户不需要在这一屏挑文件。
    // 上一级要自己算：`ancestors` 是对象数组（含当前目录），不能直接当父路径用。
    const up = dirname(result.path)
    return {
      status: 200,
      payload: {
        ok: true,
        path: result.path,
        parent: up && up !== result.path ? up : '',
        entries: result.dirs || [],
        truncated: result.truncated === true,
      },
    }
  })

  /**
   * 同一条路径既要能读又要能写时用它。
   *
   * 之前 GET 与 POST 各注册一次，后注册的那条把前一条顶掉，结果 POST 被当成
   * "只接受 GET"顶了回来（2026-11-17 实测）。一条路由里分方法处理才是对的。
   */
  const both = (path, run) => {
    disposers.push(
      mountRoute({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          if (!localOnly(req, res)) return
          if (req.method !== 'GET' && req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '这个地址只接受 GET 或 POST。' })
            return
          }
          let body = {}
          if (req.method === 'POST') {
            try {
              body = (await readBody(req)) || {}
            } catch (err) {
              sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
              return
            }
          }
          try {
            const { status, payload } = await run(req, body)
            sendJson(res, status, payload)
          } catch (err) {
            log?.warn?.(`移魂接口 ${path} 出错：${err?.message ?? err}`)
            sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
          }
        },
      }),
    )
  }

  const currentProfile = (explicit) => {
    let started = []
    try {
      const value = ctx?.get?.('profileContext')?.startedBundles
      if (Array.isArray(value)) started = value
    } catch {
      // 拿不到就交给 detectProfile 报"无法判断"。
    }
    return detectProfile(home, started, explicit ? String(explicit) : '')
  }

  post('/mini-remote/soul/export', async (body) => {
    const detected = currentProfile(body.profile)
    if (!detected.name) {
      return { status: 400, payload: { ok: false, error: `无法确定当前档案：${detected.reason}`, candidates: detected.candidates } }
    }
    const mode = ['none', 'recent', 'all'].includes(String(body.sessions)) ? String(body.sessions) : 'none'
    const outDir = String(body.dir || defaultExportDir(home))
    const result = await exportSoul({
      ctx,
      home,
      profile: detected.name,
      outDir,
      sessions: mode,
      sessionLimit: Number.isFinite(Number(body.sessionLimit)) ? Math.max(1, Number(body.sessionLimit)) : 20,
      attachments: body.attachments === true,
      pluginData: body.pluginData === true,
      // 密码只在这次调用里存在：不落盘、不进响应、不进日志。
      password: typeof body.password === 'string' ? body.password : '',
      acceptPluginVersions: body.acceptPluginVersions === true,
    })
    if (!result.ok) return { status: 400, payload: result }
    return { status: 200, payload: { ...result, profile: detected.name } }
  })

  post('/mini-remote/soul/inspect', async (body) => {
    const packDir = String(body.packDir || '').trim()
    if (!packDir) return { status: 400, payload: { ok: false, error: '要指定包目录。' } }
    const result = await inspectSoul({ packDir, ctx, home })
    return { status: result.ok ? 200 : 400, payload: result.ok ? result : { ...result, error: result.reason || result.error || '同步失败' } }
  })

  post('/mini-remote/soul/plan', async (body) => {
    const packDir = String(body.packDir || '').trim()
    if (!packDir) return { status: 400, payload: { ok: false, error: '要指定包目录。' } }
    const result = await planSoul({
      packDir,
      ctx,
      home,
      profile: body.profile ? String(body.profile) : '',
      pathMap: normalizePathMap(body.pathMap),
      acceptPluginVersions: body.acceptPluginVersions === true,
      patch: body.patch === true,
    })
    return { status: result.ok ? 200 : 400, payload: result.ok ? { ...result } : result }
  })

  /**
   * 批准目标机上"待决定"的构建脚本（2026-11-20）。
   *
   * 只改 `pnpm-workspace.yaml` 里那几行占位符，改前备份。
   * 单独一条路由，是为了让界面能"先批准、再重算计划"，而不是逼用户整笔执行。
   */
  post('/mini-remote/soul/approve-builds', async (body) => {
    let profile = String(body.profile || '').trim()
    if (!profile && body.packDir) {
      // 界面只知道包在哪；档案名从包里读，免得再让用户填一次。
      const read = await readManifest(String(body.packDir).trim())
      profile = read.ok ? String(read.manifest?.source?.profile || '').trim() : ''
    }
    if (!profile) return { status: 400, payload: { ok: false, error: '需要指定档案名。' } }
    const pending = pendingAllowBuilds(home, profile)
    if (pending.length === 0) return { status: 200, payload: { ok: true, approved: [], message: '没有待批准的构建脚本。' } }
    const approved = approveAllowBuilds(home, profile, body.names ? body.names : null)
    return { status: 200, payload: { ok: true, approved } }
  })

  post('/mini-remote/soul/apply', async (body) => {
    if (body.confirm !== true) return { status: 400, payload: { ok: false, error: '这一步会改配置和文件，需要确认（confirm: true）。' } }
    const packDir = String(body.packDir || '').trim()
    if (!packDir) return { status: 400, payload: { ok: false, error: '要指定包目录。' } }
    const result = await applySoul({
      packDir,
      ctx,
      home,
      profile: body.profile ? String(body.profile) : '',
      planId: body.planId ? String(body.planId) : '',
      confirm: true,
      pathMap: normalizePathMap(body.pathMap),
      password: typeof body.password === 'string' ? body.password : '',
      acceptPluginVersions: body.acceptPluginVersions === true,
      patch: body.patch === true,
    })
    return { status: result.ok ? 200 : 400, payload: result.ok ? result : { ...result, error: result.reason || result.error || '同步失败' } }
  })

  /**
   * 在**这台电脑**上打开一个目录（导出完成后点目录名用）。
   *
   * 为什么由宿主来做：浏览器打不开本地文件夹，只能让电脑这边动手。
   * 安全边界：只认同机、只接受目录、而且**必须落在 `$DSH_HOME` 里面**——
   * 这条路由不是"打开任何路径"的通用入口。
   */
  // ── 面板选项的记住（不存密码）──
  both('/mini-remote/soul/prefs', async (req, body) => {
    if (req.method === 'GET') {
      return { status: 200, payload: { ok: true, prefs: await readPrefs(home) } }
    }
    const saved = await writePrefs(home, body || {})
    return { status: 200, payload: { ok: true, prefs: saved } }
  })

  /**
   * 一步推送：**直接在这一步里导出**，把包落到目标目录的快照位置，再登记索引。
   *
   * 为什么不复用"先导出到本地、再拷贝"：那样要多占一份本地空间、多一次全量拷贝，
   * 而用户要的只是"点一下就好了"（2026-11-17 用户要求与导出按钮解耦）。
   */
  post('/mini-remote/soul/sync/push-live', async (body) => {
    const targetDir = String(body.targetDir || '').trim()
    if (!targetDir) return { status: 400, payload: { ok: false, error: '要指定目标目录。' } }

    const detected = currentProfile(body.profile ?? (await readPrefs(home)).profile)
    if (!detected.name) {
      return { status: 400, payload: { ok: false, error: `无法确定当前档案：${detected.reason}`, candidates: detected.candidates } }
    }

    // **以"保存过的选项"为准**：面板上没动过、甚至没打开，推送也按上次保存的来。
    // 请求体里显式给了的，优先于保存值（这样面板改了立刻生效）。
    const prefs = await readPrefs(home)
    const pick = (fromBody, fallback) => (fromBody === undefined || fromBody === null ? fallback : fromBody)
    const mode = pick(['none', 'recent', 'all'].includes(String(body.sessions)) ? String(body.sessions) : undefined,
      ['none', 'recent', 'all'].includes(String(prefs.sessions)) ? String(prefs.sessions) : 'none')
    const attachments = pick(typeof body.attachments === 'boolean' ? body.attachments : undefined, prefs.attachments === true)
    const pluginDataOn = pick(typeof body.pluginData === 'boolean' ? body.pluginData : undefined, prefs.pluginData === true)
    const sessionLimit = pick(Number.isFinite(Number(body.sessionLimit)) ? Math.max(1, Number(body.sessionLimit)) : undefined,
      Number.isFinite(Number(prefs.sessionLimit)) ? Math.max(1, Number(prefs.sessionLimit)) : 20)

    const id = snapshotId()
    const dir = join(targetDir, SNAPSHOT_DIR, id)
    await mkdir(dir, { recursive: true })

    const exported = await exportSoul({
      ctx,
      home,
      profile: detected.name,
      outDir: dir,
      sessions: mode,
      sessionLimit,
      attachments,
      pluginData: pluginDataOn,
      password: typeof body.password === 'string' ? body.password : '',
    })
    if (!exported.ok) return { status: 400, payload: exported }

    // 用过的这套选项顺手存下来：下次"点一下"就是同一套。
    await writePrefs(home, { sessions: mode, attachments, pluginData: pluginDataOn, sessionLimit, syncDir: targetDir })

    const adopted = await adoptSnapshot({
      targetDir,
      id,
      dir,
      keep: Number.isFinite(Number(body.keep)) ? Math.max(1, Number(body.keep)) : undefined,
    })
    return {
      status: adopted.ok ? 200 : 400,
      payload: { ...adopted, profile: detected.name, notes: exported.notes, bytes: adopted.bytes ?? exported.bytes },
    }
  })

  // ── 同步：本地/网盘目录 ──
  /** 用户挑的可能是快照那一层；统一翻译成索引所在的那层。 */
  const syncRootOf = async (raw) => {
    const resolved = await resolveSyncRoot(raw)
    return resolved
  }

  post('/mini-remote/soul/sync/status', async (body) => {
    const raw = String(body.targetDir || '').trim()
    if (!raw) return { status: 400, payload: { ok: false, error: '要指定目标目录。' } }
    const { root: targetDir, kind, resolved } = await syncRootOf(raw)
    if (kind === 'unknown') {
      return {
        status: 400,
        payload: {
          ok: false,
          error: '这个目录里没有同步索引（index.json）。同步根目录是「包含 snapshots 文件夹的那一层」，例如 OneDrive 根目录。',
        },
      }
    }
    const remote = await inspectTarget(targetDir)
    // 顺手比一下本地这份包：界面上"要不要推"就有依据。
    let local = { ok: false }
    const packDir = String(body.packDir || '').trim()
    if (packDir) local = await compareWithDir({ packDir, targetDir })
    return { status: 200, payload: { ok: true, remote, local, root: targetDir, rootResolved: resolved } }
  })

  post('/mini-remote/soul/sync/push', async (body) => {
    const raw = String(body.targetDir || '').trim()
    const packDir = String(body.packDir || '').trim()
    if (!raw || !packDir) return { status: 400, payload: { ok: false, error: '要指定包目录和目标目录。' } }
    const { root: targetDir } = await syncRootOf(raw)
    const result = await pushToDir({ packDir, targetDir })
    return { status: result.ok ? 200 : 400, payload: result.ok ? result : { ...result, error: result.reason || result.error || '同步失败' } }
  })

  post('/mini-remote/soul/sync/pull', async (body) => {
    const raw = String(body.targetDir || '').trim()
    if (!raw) return { status: 400, payload: { ok: false, error: '要指定目标目录。' } }
    const { root: targetDir, kind, resolved } = await syncRootOf(raw)
    if (kind === 'unknown') {
      return {
        status: 400,
        payload: {
          ok: false,
          error: '这个目录里没有同步索引（index.json）。同步根目录是「包含 snapshots 文件夹的那一层」，例如 OneDrive 根目录。',
        },
      }
    }
    const result = await pullFromDir({ targetDir, homeDir: home, which: body.which ? String(body.which) : '' })
    return { status: result.ok ? 200 : 400, payload: result.ok ? { ...result, root: targetDir, rootResolved: resolved } : { ...result, error: result.reason || result.error || '拉取失败', root: targetDir } }
  })

  post('/mini-remote/soul/open-folder', async (body) => {
    const raw = String(body.path || '').trim()
    if (!raw) return { status: 400, payload: { ok: false, error: '要指定目录。' } }
    const target = resolvePath(raw)
    const home = resolvePath(resolveHome())
    if (target !== home && !target.startsWith(home + sep)) {
      return { status: 400, payload: { ok: false, error: '只能打开 DSH 自己的目录。' } }
    }
    try {
      const info = await stat(target)
      if (!info.isDirectory()) return { status: 400, payload: { ok: false, error: '这不是一个目录。' } }
    } catch {
      return { status: 404, payload: { ok: false, error: '这个目录不存在了。' } }
    }
    openDirectory(target)
    return { status: 200, payload: { ok: true, path: target } }
  })

  post('/mini-remote/soul/rollback', async (body) => {
    const snapshotDir = String(body.snapshotDir || '').trim()
    if (!snapshotDir) return { status: 400, payload: { ok: false, error: '要指定快照目录。' } }
    const result = await rollbackSoul({ ctx, snapshotDir })
    return { status: result.ok ? 200 : 400, payload: result.ok ? result : { ...result, error: result.reason || result.error || '同步失败' } }
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        // 卸载失败不影响其余路由。
      }
    }
  }
}

/**
 * 调系统自己的文件管理器打开一个目录。
 *
 * 不等待结果、也不看退出码：资源管理器起来就返回，失败也只是"没打开"，
 * 不该让界面报错——用户的导出结果是好的。
 */
function openDirectory(dir) {
  try {
    if (process.platform === 'win32') execFile('explorer.exe', [dir])
    else if (process.platform === 'darwin') execFile('open', [dir])
    else execFile('xdg-open', [dir])
  } catch {
    // 打不开就算了，目录路径本身已经显示在界面上。
  }
}

/** 界面传来的路径映射是数组；脏数据一律丢掉，不往核心逻辑里递。 */
function normalizePathMap(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((m) => m && typeof m.oldPrefix === 'string' && typeof m.newPrefix === 'string' && m.oldPrefix && m.newPrefix)
    .slice(0, 8)
    .map((m) => ({ oldPrefix: m.oldPrefix, newPrefix: m.newPrefix }))
}
