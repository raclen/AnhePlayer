/**
 * 洛雪音源名称解析器（PC 端）：
 * 保证音源显示名称和音源检测页面（cf-anheplayer /sources）完全一致，绝不显示文件系统/临时文件名。
 */

export const REMOTE_TITLE_MAP: Record<string, string> = {
    changqing: 'ChangQing（长青）',
    flower: 'Flower',
    grass: 'Grass',
    huanyin: 'HuanYin（幻音）',
    huibq: 'Huibq',
    ikun: 'ikun',
    juhe: 'JuheApi（聚合）',
    lx: 'LX',
    qdy: 'QDY',
    sixyin: 'SixYin',
    xinghai: 'XingHai（星海）',
};

export const KNOWN_NAME_MAP: Record<string, string> = {
    '野花🌷': 'Flower',
    '野草🌾': 'Grass',
    长青SVIP音源: 'ChangQing（长青）',
    六音音源: 'SixYin',
    Huibq_lxmusic源: 'Huibq',
    ikun音源: 'ikun',
    '豆包定制[聚合音源]': 'lx-source',
    '⭐maflya-lx-音源': 'maflya-lx-音源',
};

export function parseLxMeta(code: string): { name?: string; version?: string } {
    const head = (code || '').slice(0, 8000);
    const get = (key: string) => {
        const match = head.match(new RegExp(`@${key}[ \\t]+([^\\r\\n*]+)`));
        return match ? match[1].trim() : undefined;
    };
    return {
        name: get('name'),
        version: get('version'),
    };
}

/**
 * 解析音源显示名称：
 * 1. 优先匹配检测页面 remote.json 中的在线源标识
 * 2. 匹配脚本内部 @name 在检测页面的特定别名
 * 3. 匹配检测页面本地源标题（从 hintUrlOrName 提取非哈希的有效业务名）
 * 4. 提取脚本内部 @name 及 @version
 * 5. 兜底为“自定义音源”，绝不回退为 .js 文件名或 hash 临时文件名
 */
export function resolveLxSourceName(code: string, hintUrlOrName = ''): string {
    const hint = (hintUrlOrName || '').toLowerCase();

    // 1. 检查 remote 在线源关键词
    for (const [k, title] of Object.entries(REMOTE_TITLE_MAP)) {
        if (
            hint.includes(`/${k}.js`) ||
            hint.includes(`/${k}/`) ||
            hint.endsWith(`/${k}`) ||
            hint.includes(`remote-${k}`) ||
            hint === k
        ) {
            return title;
        }
    }

    const meta = parseLxMeta(code);

    // 2. 根据脚本元数据的 @name 映射到检测页面标题
    if (meta.name && KNOWN_NAME_MAP[meta.name]) {
        return KNOWN_NAME_MAP[meta.name];
    }

    // 3. 从 hint 提取纯净名称尝试匹配检测页面标题（排除临时/哈希名称）
    const rawBase = hintUrlOrName.split(/[/\\]/).pop() || '';
    const cleanHint = rawBase.replace(/\.js$/i, '').trim();

    const isLikelyHash =
        /^[a-f0-9]{8,64}$/i.test(cleanHint) ||
        cleanHint.toLowerCase().startsWith('document:') ||
        cleanHint.toLowerCase().startsWith('blob:') ||
        cleanHint.toLowerCase().startsWith('temp');

    if (cleanHint.length > 1 && !isLikelyHash && !cleanHint.toLowerCase().endsWith('.js')) {
        return cleanHint;
    }

    // 4. 使用脚本中的 @name
    if (meta.name) {
        if (meta.version && !meta.name.includes(meta.version)) {
            return `${meta.name} v${meta.version.replace(/^v/i, '')}`;
        }
        return meta.name;
    }

    return '自定义音源';
}
