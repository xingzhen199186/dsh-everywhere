/**
 * 移魂的五个工具（P1：结构层 + 配置层）。
 *
 * 为什么要拆成"导出 / 体检 / 计划 / 执行 / 回滚"五步，而不是一个"移魂"按钮：
 * 这五步里只有执行会改东西，其余全是只读。分开了，用户在动手前能看清代价，
 * 出问题时也知道停在哪一步。**没有 planId 不许执行**，是这套流程的底线。
 */
import { detectProfile, resolveHome } from './env.js'
import { exportSoul, defaultExportDir } from './export.js'
import { inspectSoul } from './inspect.js'
import { planSoul, applySoul, rollbackSoul, countActions } from './migrate.js'

function text(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/**
 * 路径映射的入参：工具参数里用 JSON 字符串最稳（数组参数在工具 schema 里不一定被支持）。
 * 同时容忍直接给数组，调用方少踩一次坑。
 */
function parsePathMap(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: [] }
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      return { error: `pathMap 不是合法 JSON：${err.message}` }
    }
  }
  if (!Array.isArray(parsed)) return { error: 'pathMap 要是数组' }
  const value = parsed
    .filter((m) => m && typeof m.oldPrefix === 'string' && typeof m.newPrefix === 'string' && m.oldPrefix && m.newPrefix)
    .map((m) => ({ oldPrefix: m.oldPrefix, newPrefix: m.newPrefix }))
  return { value }
}

function asError(err) {
  return JSON.stringify({ ok: false, error: String(err?.message ?? err) })
}

/**
 * @param {object} p
 * @param {object} p.ctx 插件 ctx
 * @param {object} p.toolsCtx 带 tools 服务的 ctx
 * @param {Function} p.defineTool DSH 的工具定义
 * @param {object} p.log 日志
 */
export function registerSoulTools({ ctx, toolsCtx, defineTool, log }) {
  const home = resolveHome()
  const profileContext = () => ctx?.get?.('profileContext')
  const startedBundles = () => {
    try {
      const value = profileContext()?.startedBundles
      return Array.isArray(value) ? value : []
    } catch {
      return []
    }
  }

  const tools = [
    {
      name: 'soul_export',
      description:
        '把当前这台电脑上 DSH 的「灵魂」导出成一份可搬运的包：档案装了哪些插件（含安装源与版本）、各插件生效配置、两层补丁、AGENTS.md、技能、预设。不含会话与附件，不含密钥。导出前会先报体积。',
      parameters: {
        dir: { type: 'string', description: '导出到哪个目录；不填就用 $DSH_HOME/dsh-everywhere/souls/soul-<时间>。' },
        profile: { type: 'string', description: '要导出哪个档案；不填则自动判断，判断不出来会要求你指定。' },
        sessions: { type: 'string', description: '会话怎么带：none（默认，不带）/ recent（只带最近若干个）/ all（全带）。' },
        sessionLimit: { type: 'number', description: 'sessions=recent 时带多少个，默认 20。' },
        attachments: { type: 'boolean', description: '是否连附件一起带（图片等，内容寻址，可能很大）。默认 false。' },
        pluginData: { type: 'boolean', description: '是否连插件私有数据一起带（记忆库等，白名单制，缓存不收）。默认 false。' },
      },
      async run(args) {
        const detected = detectProfile(home, startedBundles(), args?.profile)
        if (!detected.name) {
          return {
            ok: false,
            error: `无法确定当前档案：${detected.reason}`,
            candidates: detected.candidates,
            next: '用 profile 参数指定一个档案名再试一次。',
          }
        }
        const mode = ['none', 'recent', 'all'].includes(String(args?.sessions)) ? String(args.sessions) : 'none'
        const sessionLimit = Number.isFinite(Number(args?.sessionLimit)) ? Math.max(1, Number(args.sessionLimit)) : 20
        const outDir = String(args?.dir || defaultExportDir(home))
        const result = await exportSoul({
          ctx,
          home,
          profile: detected.name,
          outDir,
          sessions: mode,
          sessionLimit,
          attachments: args?.attachments === true,
          pluginData: args?.pluginData === true,
        })
        if (!result.ok) return result
        return {
          ...result,
          profile: detected.name,
          profileReason: detected.reason,
          next: '把整个目录拷到另一台电脑，在那台机器上用 soul_inspect 看它，再 soul_plan / soul_apply。',
        }
      },
    },
    {
      name: 'soul_inspect',
      description:
        '只读体检一份移魂包：里面有什么、校验和对不对、目标机缺哪些插件、哪些配置会覆盖。**它不写任何东西**，是动手前该先看的一步。',
      parameters: {
        packDir: { type: 'string', description: '移魂包目录（就是 soul_export 输出的那个目录）。' },
      },
      async run(args) {
        const packDir = String(args?.packDir || '').trim()
        if (!packDir) return { ok: false, error: '要指定 packDir（灵魂包目录）' }
        return inspectSoul({ packDir, ctx, home })
      },
    },
    {
      name: 'soul_plan',
      description:
        '生成注入计划（只读、dry-run）：会启用哪些插件、替换哪些配置、新建或覆盖哪些文件，以及**哪些项会被跳过**。返回 planId，执行时必须带上它。',
      parameters: {
        packDir: { type: 'string', description: '移魂包目录。' },
        profile: { type: 'string', description: '注入到哪个档案；不填则用包里记录的来源档案名。' },
        pathMap: { type: 'string', description: '路径映射，JSON 数组字符串：[{"oldPrefix":"I:\\旧目录","newPrefix":"D:\\新目录"}]。会话的 cwd 会按它改写。' },
        patch: { type: 'boolean', description: '是否显式迁移两层 cordis.patch.yml。默认 false；执行时也要传相同值。' },
      },
      async run(args) {
        const packDir = String(args?.packDir || '').trim()
        if (!packDir) return { ok: false, error: '要指定 packDir（灵魂包目录）' }
        const pathMap = parsePathMap(args?.pathMap)
        if (pathMap.error) return { ok: false, error: pathMap.error }
        const result = await planSoul({ packDir, ctx, home, profile: args?.profile ? String(args.profile) : '', pathMap: pathMap.value, patch: args?.patch === true })
        if (!result.ok) return result
        return {
          ok: true,
          planId: result.planId,
          profile: result.plan.targetProfile,
          target: result.plan.targetBinding,
          summary: result.summary,
          items: result.plan.items.map((i) => ({ action: i.action, what: i.target, detail: i.detail })),
          secrets: result.plan.items.some((i) => i.kind === 'secrets'),
          next: result.plan.items.some((i) => i.kind === 'secrets')
            ? '这个包带加密凭据：只能用 soul_apply 写其余部分，凭据要由用户在设置页输密码写入（agent 拿不到密码）。'
            : '确认无误后用 soul_apply 带上这个 planId 执行。',
        }
      },
    },
    {
      name: 'soul_apply',
      description:
        '按计划注入：先备份，再**安装目标机缺的插件**、启用插件、写配置与文件。**必须带 confirm:true**，且 planId 要和计划一致（计划或绑定目标变了会被拒绝、零写入）。目标机已有同款但版本不同时，会先卸再装（官方规定不能直接覆盖）。两层 patch 默认不搬，只有计划和执行都显式传 patch:true 才会检查并迁移。',
      parameters: {
        packDir: { type: 'string', description: '移魂包目录。' },
        planId: { type: 'string', description: 'soul_plan 返回的 planId；带上它可以防止"计划看过了但又变了"。' },
        profile: { type: 'string', description: '注入到哪个档案；不填则用包里记录的来源档案名。' },
        confirm: { type: 'boolean', description: '必须为 true 才会真的写盘。' },
        pathMap: { type: 'string', description: '与 soul_plan 相同的路径映射 JSON；要和计划里用的一致，否则指纹对不上。' },
        patch: { type: 'boolean', description: '必须与 soul_plan 使用相同值；默认 false，两层 cordis.patch.yml 不搬。' },
      },
      async run(args) {
        const packDir = String(args?.packDir || '').trim()
        if (!packDir) return { ok: false, error: '要指定 packDir（灵魂包目录）' }
        const pathMap = parsePathMap(args?.pathMap)
        if (pathMap.error) return { ok: false, error: pathMap.error }
        return applySoul({
          packDir,
          ctx,
          home,
          profile: args?.profile ? String(args.profile) : '',
          planId: args?.planId ? String(args.planId) : '',
          confirm: args?.confirm === true,
          pathMap: pathMap.value,
          patch: args?.patch === true,
        })
      },
    },
    {
      name: 'soul_rollback',
      description:
        '把一次注入整笔退回：文件按备份还原，配置与插件启用状态按记录改回。快照目录由 soul_apply 的返回给出。',
      parameters: {
        snapshotDir: { type: 'string', description: 'soul_apply 返回的快照目录。' },
      },
      async run(args) {
        const snapshotDir = String(args?.snapshotDir || '').trim()
        if (!snapshotDir) return { ok: false, error: '要指定 snapshotDir（soul_apply 返回的那个目录）' }
        return rollbackSoul({ ctx, snapshotDir })
      },
    },
  ]

  for (const tool of tools) {
    try {
      toolsCtx.effect(() =>
        toolsCtx.tools.register(
          defineTool({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            output: {
              schema: { type: 'string' },
              render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
            },
            async execute(args) {
              try {
                // **绝不受理密码**：凭据只能由人在设置页里操作。
                if (args && Object.prototype.hasOwnProperty.call(args, 'password')) {
                  return JSON.stringify({
                    ok: false,
                    error: '这个工具不接受密码。凭据只能在「设置 → 遥控设置 → 移魂大法」里由你本人输入密码导出/写入。',
                  })
                }
                return text(await tool.run(args))
              } catch (err) {
                return asError(err)
              }
            },
          }),
        ),
      )
    } catch (err) {
      log?.warn?.(`移魂工具 ${tool.name} 没有注册：${err?.message ?? err}`)
    }
  }

  return { count: tools.length, countActions }
}
