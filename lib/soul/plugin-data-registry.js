/**
 * 插件私有数据区（照搬自 dsh-config-manager@0.10.0）
 *
 * 原文件：`node_modules/dsh-config-manager/lib/core/plugin-data-registry.js`
 * 许可证：MIT，Copyright (c) 2026 xiajiajun516
 * 照搬理由：这份表是**取证出来的知识**（哪个插件的哪个目录有什么、哪些含凭据、哪些是缓存），
 * 自己重写既没有新信息，还容易漏掉"命中凭据就整条不收"这种安全判断。按用户要求直接搬，
 * 只加这个出处说明。
 *
 * 我们对它的改动：**没有**。函数与数据一字未改，方便以后对照上游升级。
 */
/**
 * 内置来源 —— 只放已取证的。
 *
 * 收录口径（2026-10-14 调研：按 GitHub star + npm 周下载量排序后逐一核对）：
 *  - 有自有数据目录（不在 DSH 三个核心存储里，也不在 profile 树里）；
 *  - 目录里不含凭据（~/.commandcode/auth.json、~/.dsh/agy-accounts 这类命中即整来源不收录 ——
 *    文件类分区的内容不进 SecretScanner 的剥离路径，带出去就是明文）；
 *  - 位置由插件自己的 README 明示，或本机实测。
 *
 * 未收录但确实有数据目录的插件（如实登记，避免「没列出来 = 不存在」的误读）：
 *  - dsh-better-sidebar（4175 star）：状态全在 DSH settings/storages，已被既有分区覆盖；
 *  - @mars-sea/dsh-commandcode-provider（389 star）：~/.commandcode/ 含 auth.json（凭据）；
 *  - dsh-agy-link（111 star）：~/.dsh/agy-accounts 为账号池（凭据）。
 */
export const BUILTIN_PLUGIN_DATA_SOURCES = [
    {
        // README「配置与数据」表逐项明示：数据目录 + 缓存/上传/官方资源的覆盖变量
        id: 'wallpaper-engine',
        packages: ['dsh-plugin-wallpaper-engine'],
        evidence: 'documented',
        areas: [
            {
                relPath: '.dsh-wallpaper-engine',
                role: 'config',
                envOverrides: ['DSH_WE_DATA_DIR'],
                // cache = 抽帧/转码/缩略图（可再生产物）；uploads 进 assets；bin 由插件管理（按需下载的运行时）
                excludeRel: ['cache', 'uploads', 'bin'],
            },
            {
                relPath: '.dsh-wallpaper-engine/uploads',
                role: 'assets',
                envOverrides: ['DSH_WE_DATA_DIR', 'DSH_WE_UPLOAD_DIR'],
            },
            {
                relPath: '.dsh-wallpaper-engine/cache',
                role: 'cache',
                envOverrides: ['DSH_WE_DATA_DIR', 'DSH_WE_CACHE_DIR'],
            },
        ],
    },
    {
        // 本机实测（~/.mnemon 下 runtime / data / documents 三个子目录）；MNEMON_DATA_DIR 覆盖整个根
        id: 'mnemon',
        packages: ['dsh-mnemon'],
        evidence: 'measured',
        areas: [
            { relPath: '.mnemon/runtime', role: 'config', envOverrides: ['MNEMON_DATA_DIR'] },
            { relPath: '.mnemon/data', role: 'assets', envOverrides: ['MNEMON_DATA_DIR'] },
            { relPath: '.mnemon/documents', role: 'assets', envOverrides: ['MNEMON_DATA_DIR'] },
        ],
    },
    {
        // README 明示 ~/.fastctx/ 为持久状态（只有 --purge-fastctx 才删）
        id: 'dsh-ops',
        packages: ['dsh-ops'],
        evidence: 'documented',
        areas: [{ relPath: '.fastctx', role: 'assets' }],
    },
    {
        // README 明示：所有设置落 ~/.dsh/.dsh-any-background-data/（不是 localStorage）
        id: 'any-background',
        packages: ['dsh-any-background'],
        evidence: 'documented',
        areas: [{ relPath: '.dsh/.dsh-any-background-data', role: 'config' }],
    },
    {
        // README 明示 ~/.opencode2dsh/adapter-status.json
        id: 'opencode2dsh',
        packages: ['@opencode2dsh/dsh-plugin'],
        evidence: 'documented',
        areas: [{ relPath: '.opencode2dsh', role: 'config' }],
    },
];
/** 角色 → 分区（cache 不属于任何分区） */
export function sectionOfRole(role) {
    if (role === 'config')
        return 'pluginData';
    if (role === 'assets')
        return 'pluginAssets';
    return null;
}
/** 该分区要收集的区域清单（保序：来源顺序 → 区域内顺序） */
export function areasForSection(sources, section) {
    const out = [];
    for (const source of sources) {
        for (const area of source.areas) {
            if (sectionOfRole(area.role) === section)
                out.push({ source, area });
        }
    }
    return out;
}
/**
 * home 相对路径归一化 + 安全判定。
 *
 * 只接受 POSIX 相对路径：拒绝绝对路径（含 Windows 盘符写法 C:/x）、..、反斜杠、空段、
 * 以 / 结尾、含 NUL 的值。
 * 返回 null = 调用方必须报错/跳过，绝不「尽力而为」地拼一个路径出来。
 */
export function normalizeHomeRel(value) {
    if (typeof value !== 'string')
        return null;
    const v = value.trim().replace(/\\/g, '/');
    if (v === '' || v.startsWith('/') || /^[A-Za-z]:/.test(v) || v.includes('\u0000'))
        return null;
    if (v.endsWith('/'))
        return null;
    for (const part of v.split('/')) {
        if (part === '' || part === '.' || part === '..')
            return null;
    }
    return v;
}
/**
 * 目录区域的排除判定（issue：**excludeRel 是区域相对路径，rel 是 home 相对路径**）。
 *
 * 必须先把 rel 折成区域相对再比：`excludeRel: ['uploads']` 配 `.dsh-wallpaper-engine` 区域时，
 * 真正的判别对象是 `uploads/a.mp4`（区域相对），不是 `.dsh-wallpaper-engine/uploads/a.mp4`（home 相对）——
 * 直接拿 home 相对路径去 startsWith，排除项永远不命中，缓存与大资产会悄悄跟着配置分区一起进包。
 */
export function isExcludedRel(area, rel) {
    const inner = rel === area.relPath
        ? ''
        : rel.startsWith(area.relPath + '/') ? rel.slice(area.relPath.length + 1) : null;
    if (inner === null || inner === '')
        return false;
    for (const ex of area.excludeRel ?? []) {
        if (inner === ex || inner.startsWith(ex + '/'))
            return true;
    }
    return false;
}
/** rel 是否属于该区域（文件区域 = 精确相等；目录区域 = 精确相等或前缀） */
export function relInArea(area, rel) {
    if (rel === area.relPath)
        return true;
    return rel.startsWith(area.relPath + '/');
}
/**
 * 路径 → 区域（最长前缀优先）。
 *
 * 为什么必须最长优先：.dsh-wallpaper-engine 与 .dsh-wallpaper-engine/uploads 同时是区域，
 * 短前缀先匹配会把上传的壁纸算进「配置」分区（用户取消勾选大资产也照样带走几百 MB）。
 */
export function areaOfPath(entries, rel) {
    let best = null;
    for (const entry of entries) {
        if (!relInArea(entry.area, rel))
            continue;
        if (isExcludedRel(entry.area, rel))
            continue;
        if (best === null || entry.area.relPath.length > best.area.relPath.length)
            best = entry;
    }
    return best;
}
/**
 * 解析一个已安装插件 package.json 里的自述声明（dsh.dataDirs）—— 「让别的插件自己适配」的钩子。
 *
 * 契约（对外文档见 docs/contracts/plugin-data-declaration.md）：
 *   { "dsh": { "dataDirs": [ { "path": ".my-plugin", "role": "config", "env": ["MY_PLUGIN_DIR"] } ] } }
 *
 * 形状不认识就整条丢弃（返回 null），绝不猜；path 非法（绝对路径 / .. / 空段）同样丢弃。
 */
export function parseDeclaredDataDirs(packageName, manifest) {
    if (manifest === null || typeof manifest !== 'object')
        return null;
    const dsh = manifest.dsh;
    if (dsh === null || typeof dsh !== 'object')
        return null;
    const raw = dsh.dataDirs;
    if (!Array.isArray(raw) || raw.length === 0)
        return null;
    const areas = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            return null;
        const rec = item;
        const relPath = normalizeHomeRel(rec.path);
        if (relPath === null)
            return null;
        const role = rec.role === 'assets' ? 'assets' : rec.role === 'cache' ? 'cache' : 'config';
        const envOverrides = Array.isArray(rec.env)
            ? rec.env.filter((e) => typeof e === 'string' && e !== '')
            : [];
        const excludes = Array.isArray(rec.exclude)
            ? rec.exclude.map((e) => normalizeHomeRel(e)).filter((e) => e !== null)
            : [];
        areas.push({
            relPath,
            role,
            ...(envOverrides.length > 0 ? { envOverrides } : {}),
            ...(excludes.length > 0 ? { excludeRel: excludes } : {}),
        });
    }
    return { id: 'declared:' + packageName, packages: [packageName], evidence: 'documented', areas };
}
//# sourceMappingURL=plugin-data-registry.js.map