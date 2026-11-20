/**
 * 洛雪音源名称解析器（PC 端）：
 * 保证音源显示名称和音源检测页面（cf-anheplayer /sources）完全一致，绝不使用文件名称或临时哈希。
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

export function parseLxMeta(code: string): {
    name?: string;
    version?: string;
    author?: string;
    description?: string;
} {
    const head = (code || '').slice(0, 10000);
    const get = (key: string) => {
        const match = head.match(new RegExp(`@${key}[ \\t]+([^\\r\\n*]+)`));
        return match ? match[1].trim() : undefined;
    };

    let name = get('name');
    if (!name) {
        const nameMatch = head.match(/name\s*:\s*['"]([^'"]+)['"]/);
        if (nameMatch) {
            name = nameMatch[1].trim();
        }
    }

    let version = get('version');
    if (!version) {
        const verMatch = head.match(/version\s*:\s*['"]([^'"]+)['"]/);
        if (verMatch) {
            version = verMatch[1].trim();
        }
    }

    return {
        name,
        version,
        author: get('author'),
        description: get('description'),
    };
}

/**
 * 解析音源显示名称：
 * 1. 优先匹配检测页面 remote.json 中的在线源标识（根据 URL 特征匹配）
 * 2. 匹配脚本内部元数据（@name 或代码声明的 name）
 *    - 若匹配已知映射表，则返回音源检测页面的对齐名称
 *    - 若存在版本号且名称中未包含版本，格式化为 `${name} v${version}`
 * 3. 兜底返回“自定义音源”，绝不使用任何文件名称或临时哈希。
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

    // 2. 根据脚本元数据的 name 映射到检测页面标题
    if (meta.name) {
        if (KNOWN_NAME_MAP[meta.name]) {
            return KNOWN_NAME_MAP[meta.name];
        }

        if (meta.version && !meta.name.toLowerCase().includes(meta.version.toLowerCase())) {
            return `${meta.name} v${meta.version.replace(/^v/i, '')}`;
        }
        return meta.name;
    }

    // 3. 兜底为“自定义音源”，绝不使用任何文件名称
    return '自定义音源';
}
