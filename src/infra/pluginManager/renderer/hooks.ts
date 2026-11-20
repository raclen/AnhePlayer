/**
 * pluginManager — React Hooks
 *
 * 提供插件状态的 React Hook 封装，组件直接使用 hook 订阅状态，
 * 不再需要手动操作 atom。
 *
 * 基础 Hook：
 *   usePlugins()      — 插件 delegate 列表
 *   usePluginMeta()   — 全量插件 meta
 *
 * 派生 Hook（内建 useMemo，自动窄化依赖）：
 *   useSortedSupportedPlugins(method)       — 支持指定方法的插件（按 order 排序）
 *   useSortedSearchablePlugins(searchType?) — 支持搜索的插件（可选按搜索类型过滤，按 order 排序）
 */

import { useMemo } from 'react';
import { useAtomValue } from 'jotai/react';
import { pluginsAtom, pluginMetaAtom, pluginAvailabilityAtom, activeSourceHashAtom } from './store';
import { sortByPluginOrder } from '../common/sortByOrder';

// ─── 基础 Hooks ───

/** 订阅插件列表 */
export const usePlugins = () => useAtomValue(pluginsAtom);

/** 订阅插件 meta */
export const usePluginMeta = () => useAtomValue(pluginMetaAtom);

/** 订阅音源可用性检测结果（按 hash 索引） */
export const usePluginAvailability = () => useAtomValue(pluginAvailabilityAtom);

/** 订阅当前激活的音源哈希 */
export const useActiveSourceHash = () => useAtomValue(activeSourceHashAtom);

// ─── 派生 Hooks ───
// 注意：派生 hook 同时订阅 pluginsAtom 和 pluginMetaAtom，
// 任一更新都会触发 re-render + useMemo 重算。如果成为性能瓶颈，
// 可改用 jotai derived atom 做细粒度选择。目前场景下开销可忽略。

/**
 * 获取支持指定方法的插件列表（按 meta.order 排序）。
 *
 * @param featureMethod - 插件实例方法名
 * @param enabledOnly - 仅返回已启用的插件（默认 true）
 */
export function useSortedSupportedPlugins(
    featureMethod: keyof IPlugin.IPluginInstanceMethods,
    enabledOnly = true,
): IPlugin.IPluginDelegate[] {
    const plugins = useAtomValue(pluginsAtom);
    const meta = useAtomValue(pluginMetaAtom);

    return useMemo(
        () =>
            sortByPluginOrder(
                plugins.filter(
                    (p) =>
                        p.supportedMethod.includes(featureMethod) &&
                        (!enabledOnly || meta[p.hash]?.enabled !== false),
                ),
                meta,
            ),
        [plugins, meta, featureMethod, enabledOnly],
    );
}

/**
 * 获取支持搜索功能的插件列表（按 meta.order 排序）。
 *
 * @param supportedSearchType - 可选，限定搜索类型（music / album / artist / sheet）
 * @param enabledOnly - 仅返回已启用的插件（默认 true）
 */
export function useSortedSearchablePlugins(
    supportedSearchType?: IMedia.SupportMediaType,
    enabledOnly = true,
): IPlugin.IPluginDelegate[] {
    const plugins = useAtomValue(pluginsAtom);
    const meta = useAtomValue(pluginMetaAtom);

    return useMemo(
        () =>
            sortByPluginOrder(
                plugins
                    .filter(
                        (p) =>
                            p.supportedMethod.includes('search') &&
                            (!enabledOnly || meta[p.hash]?.enabled !== false),
                    )
                    .filter((p) =>
                        supportedSearchType && p.supportedSearchType
                            ? p.supportedSearchType.includes(supportedSearchType)
                            : true,
                    ),
                meta,
            ),
        [plugins, meta, supportedSearchType, enabledOnly],
    );
}

export const PLATFORM_LABEL_MAP: Record<string, string> = {
    kw: '酷我',
    kg: '酷狗',
    tx: 'QQ音乐',
    wy: '网易云',
    mg: '咪咕',
    qs: '汽水',
    qishui: '汽水',
    bili: 'B站',
    local: '本地',
};

export interface ISourceGroup {
    sourceHash: string;
    name: string;
    version?: string;
    author?: string;
    description?: string;
    platformKeys: string[];
    platformNames: string[];
    supportedMethods: string[];
    srcUrl?: string;
    delegates: IPlugin.IPluginDelegate[];
    isActive: boolean;
    enabled: boolean;
    order: number;
}

/**
 * 获取以「音源（脚本包）」为维度的多音源分组列表（对齐移动端多音源结构）
 */
export function useSourceGroups(): ISourceGroup[] {
    const plugins = useAtomValue(pluginsAtom);
    const meta = useAtomValue(pluginMetaAtom);
    const activeSourceHash = useAtomValue(activeSourceHashAtom);

    return useMemo(() => {
        const customPlugins = plugins.filter(
            (p) => p.hash !== LOCAL_PLUGIN_HASH && p.platform !== 'local',
        );

        // 按 sourceHash 分组
        const groupMap = new Map<string, IPlugin.IPluginDelegate[]>();
        for (const p of customPlugins) {
            const sh = p.sourceHash || p.hash.split(':')[0] || p.hash;
            const list = groupMap.get(sh) || [];
            list.push(p);
            groupMap.set(sh, list);
        }

        const groups: ISourceGroup[] = [];
        let index = 0;
        for (const [sourceHash, delegates] of groupMap.entries()) {
            const first = delegates[0];
            const name = first.sourceName || '自定义音源';
            const version = first.version;
            const author = first.author;
            const description = first.description;
            const platformKeys = delegates.map((d) => d.platform);
            const platformNames = delegates.map(
                (d) => PLATFORM_LABEL_MAP[d.platform] || d.platform,
            );
            const supportedMethods = Array.from(
                new Set(delegates.flatMap((d) => d.supportedMethod || [])),
            );
            const srcUrl = delegates.find((d) => d.srcUrl)?.srcUrl;
            const isActive = sourceHash === activeSourceHash || (!activeSourceHash && index === 0);
            const enabled = delegates.some((d) => meta[d.hash]?.enabled !== false);
            const order = Math.min(...delegates.map((d) => meta[d.hash]?.order ?? 999999));

            groups.push({
                sourceHash,
                name,
                version,
                author,
                description,
                platformKeys,
                platformNames,
                supportedMethods,
                srcUrl,
                delegates,
                isActive,
                enabled,
                order,
            });
            index++;
        }

        // 激活的音源排在前面，其余按 order 排序
        return groups.sort((a, b) => {
            if (a.isActive && !b.isActive) return -1;
            if (!a.isActive && b.isActive) return 1;
            return a.order - b.order;
        });
    }, [plugins, meta, activeSourceHash]);
}
