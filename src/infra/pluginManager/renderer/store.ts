/**
 * pluginManager — Renderer jotai Store
 *
 * 集中管理插件状态的 jotai atom 和 store 实例。
 * index.ts（命令式 API）和 hooks.ts（React Hook）均从此文件导入。
 */

import { atom, getDefaultStore } from 'jotai';
import type { IPluginMetaAll } from '@appTypes/infra/pluginManager';

export const store = getDefaultStore();

// ─── Atoms ───

/** 插件 delegate 列表 */
export const pluginsAtom = atom<IPlugin.IPluginDelegate[]>([]);

/** 全量插件 meta（排序、启用状态、用户变量等） */
export const pluginMetaAtom = atom<IPluginMetaAll>({});

/**
 * 音源可用性检测状态（运行时状态，不持久化，重启后回到未检测）
 *
 * - unchecked：未检测
 * - checking：检测中
 * - available：可用（探测接口有正常返回）
 * - unavailable：不可用（请求失败、超时或接口无结果）
 * - unsupported：插件没有可探测的接口
 */
export type PluginAvailabilityState =
    | 'unchecked'
    | 'checking'
    | 'available'
    | 'unavailable'
    | 'unsupported';

export interface IPluginAvailabilityResult {
    state: PluginAvailabilityState;
    /** 不可用原因（仅 unavailable 时有值） */
    message?: string;
    /** 最近一次检测完成时间戳 */
    checkedAt?: number;
}

/** 按插件 hash 索引的可用性检测结果 */
export const pluginAvailabilityAtom = atom<Record<string, IPluginAvailabilityResult>>({});

/** 当前激活的音源源文件哈希 */
export const activeSourceHashAtom = atom<string>('');
