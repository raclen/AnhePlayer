import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Palette } from 'lucide-react';
import { useTranslation, Trans } from 'react-i18next';
import { atom, getDefaultStore } from 'jotai';
import { useAtomValue } from 'jotai/react';
import themePack, { useCurrentThemePack, useInstalledThemePacks } from '@infra/themepack/renderer';
import type { IThemePack } from '@appTypes/infra/themepack';
import { RequestStatus } from '@common/constant';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { StatusPlaceholder } from '@renderer/mainWindow/components/ui/StatusPlaceholder';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import { showModal } from '@renderer/mainWindow/components/ui/Modal/modalManager';
import { showContextMenu } from '@renderer/mainWindow/components/ui/ContextMenu/contextMenuManager';
import { ThemeCard } from '../ThemeCard';
import { ThemePreview } from '../ThemePreview';
import { Chip } from '@renderer/mainWindow/components/ui/Chip';
import { A } from '@renderer/mainWindow/components/ui/A';
import { THEME_STORE_BASE_URLS, GITHUB_REPO_URL } from '../../constants';
import './index.scss';

interface ICuratedThemeItem {
    id: string;
    name: string;
    author?: string;
    authorUrl?: string;
    description?: string;
    version?: string;
    tags?: string[];
    preview?: string;
    sourcePath: string;
    isNew?: boolean;
}

/** publish.json 顶层结构 */
interface IRemotePublishData {
    version: string;
    updatedAt: string;
    themes: IRemoteThemeItem[];
}

/** 远程主题列表中的单个条目（扁平结构，与 publish.json 中 themes[] 一致） */
interface IRemoteThemeItem {
    id: string;
    name: string;
    packageName: string;
    author?: string;
    authorUrl?: string;
    description?: string;
    version?: string;
    tags?: string[];
    preview?: string;
    themeUrl: string;
    hash: string;
    publishName: string;
    createdAt?: string;
    isNew?: boolean;
}

type ThemeMarketViewModel =
    | {
          kind: 'curated';
          key: string;
          installKey: string;
          item: ICuratedThemeItem;
          previewUrl?: string;
      }
    | {
          kind: 'remote';
          key: string;
          installKey: string;
          item: IRemoteThemeItem;
          srcUrl: string;
          previewUrl?: string;
      };

function buildResPath(relativePath: string): string {
    return `${globalContext.appPath.res}/${relativePath}`;
}

function buildFileUrl(relativePath: string): string {
    return `file:///${buildResPath(relativePath).replace(/\\/g, '/')}`;
}

const curatedThemes: ThemeMarketViewModel[] = [
    {
        kind: 'curated',
        key: 'curated:figma-soft-light',
        installKey: 'curated:figma-soft-light',
        item: {
            id: 'figma-soft-light',
            name: '柔雾白昼',
            author: 'raclen',
            authorUrl: 'https://github.com/raclen',
            description: 'Figma 风格的浅色主题，带有奶油纸感背景、珊瑚强调色与柔和玻璃层次',
            version: '1.0.0',
            tags: ['Figma', '浅色', '柔和'],
            sourcePath: buildResPath('theme-store/curated/figma-soft-light'),
            isNew: true,
        },
        previewUrl: buildFileUrl('theme-store/curated/figma-soft-light/thumb.svg'),
    },
    {
        kind: 'curated',
        key: 'curated:figma-aurora-dark',
        installKey: 'curated:figma-aurora-dark',
        item: {
            id: 'figma-aurora-dark',
            name: '极夜流光',
            author: 'raclen',
            authorUrl: 'https://github.com/raclen',
            description: 'Figma 风格的深色主题，冷蓝玻璃面板搭配青绿流光与更强的空间层次',
            version: '1.0.0',
            tags: ['Figma', '深色', '玻璃'],
            sourcePath: buildResPath('theme-store/curated/figma-aurora-dark'),
            isNew: true,
        },
        previewUrl: buildFileUrl('theme-store/curated/figma-aurora-dark/thumb.svg'),
    },
    {
        kind: 'curated',
        key: 'curated:apple-music-silk',
        installKey: 'curated:apple-music-silk',
        item: {
            id: 'apple-music-silk',
            name: 'Silk Motion',
            author: 'raclen',
            authorUrl: 'https://github.com/raclen',
            description: '更偏 Apple Music 风的丝滑浅色主题，半透明分层、克制留白和柔和桃粉强调色',
            version: '1.0.0',
            tags: ['Apple Music', '浅色', '玻璃'],
            sourcePath: buildResPath('theme-store/curated/apple-music-silk'),
            isNew: true,
        },
        previewUrl: buildFileUrl('theme-store/curated/apple-music-silk/thumb.svg'),
    },
    {
        kind: 'curated',
        key: 'curated:linear-pulse',
        installKey: 'curated:linear-pulse',
        item: {
            id: 'linear-pulse',
            name: 'Pulse Grid',
            author: 'raclen',
            authorUrl: 'https://github.com/raclen',
            description: '更偏 Linear / Raycast 风的高密度深色主题，锐利线条、冷白文本和青蓝焦点',
            version: '1.0.0',
            tags: ['Linear', 'Raycast', '深色'],
            sourcePath: buildResPath('theme-store/curated/linear-pulse'),
            isNew: true,
        },
        previewUrl: buildFileUrl('theme-store/curated/linear-pulse/thumb.svg'),
    },
    {
        kind: 'curated',
        key: 'curated:hype-wave',
        installKey: 'curated:hype-wave',
        item: {
            id: 'hype-wave',
            name: 'Hype Wave',
            author: 'raclen',
            authorUrl: 'https://github.com/raclen',
            description: '更偏潮流音乐产品风的高对比主题，荧光黄绿、深色舞台背景和更强的节奏感',
            version: '1.0.0',
            tags: ['潮流音乐', '深色', '高对比'],
            sourcePath: buildResPath('theme-store/curated/hype-wave'),
            isNew: true,
        },
        previewUrl: buildFileUrl('theme-store/curated/hype-wave/thumb.svg'),
    },
];

/**
 * 将远程相对路径或 #hex 纯色解析为完整 URL。
 */
function resolvePreviewUrl(raw: string | undefined, baseUrl: string): string | undefined {
    if (!raw) return undefined;
    if (raw.startsWith('#')) return raw;
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    return `${baseUrl}${raw}`;
}

/**
 * 竞速请求多个镜像，返回第一个成功的结果。
 */
async function raceWithData(
    urls: string[],
): Promise<{ data: IRemoteThemeItem[]; baseUrl: string }> {
    const controllers = urls.map(() => new AbortController());

    const promises = urls.map(async (baseUrl, i) => {
        const resp = await fetch(`${baseUrl}publish.json`, {
            signal: controllers[i].signal,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = (await resp.json()) as IRemotePublishData;
        return { data: json.themes, baseUrl };
    });

    try {
        const result = await Promise.any(promises);
        controllers.forEach((c) => c.abort());
        return result;
    } catch {
        throw new Error('All mirrors failed');
    }
}

const store = getDefaultStore();
const remoteThemesAtom = atom<ThemeMarketViewModel[]>(curatedThemes);
const remoteStatusAtom = atom<RequestStatus>(RequestStatus.Done);
const installingHashAtom = atom<Set<string>>(new Set<string>());

export default function RemoteThemes() {
    const { t } = useTranslation();
    const currentPack = useCurrentThemePack();
    const installedPacks = useInstalledThemePacks();

    const status = useAtomValue(remoteStatusAtom);
    const themes = useAtomValue(remoteThemesAtom);
    const installingHashes = useAtomValue(installingHashAtom);
    const [activeTag, setActiveTag] = useState<string | null>(null);

    const allTags = useMemo(() => {
        const tagSet = new Set<string>();
        for (const vm of themes) {
            vm.item.tags?.forEach((tag) => tagSet.add(tag));
        }
        return Array.from(tagSet).sort((a, b) => a.localeCompare(b));
    }, [themes]);

    const filteredThemes = useMemo(
        () => (activeTag ? themes.filter((vm) => vm.item.tags?.includes(activeTag)) : themes),
        [themes, activeTag],
    );

    const loadThemes = useCallback(async () => {
        if (store.get(remoteStatusAtom) !== RequestStatus.Done) {
            store.set(remoteStatusAtom, RequestStatus.Done);
        }

        const loadedKeys = new Set(curatedThemes.map((vm) => vm.key));

        try {
            const { data, baseUrl } = await raceWithData(THEME_STORE_BASE_URLS);
            const remoteViewModels: ThemeMarketViewModel[] = data
                .map((item) => ({
                    kind: 'remote' as const,
                    key: `remote:${item.hash}`,
                    installKey: item.hash,
                    item,
                    srcUrl: `${baseUrl}${item.themeUrl}`,
                    previewUrl: resolvePreviewUrl(item.preview, baseUrl),
                }))
                .filter((vm) => {
                    if (loadedKeys.has(vm.key)) return false;
                    loadedKeys.add(vm.key);
                    return true;
                });

            if (remoteViewModels.length > 0) {
                store.set(remoteThemesAtom, [...curatedThemes, ...remoteViewModels]);
            }
        } catch {
            // 远程主题不可用时，保留策展主题即可。
        }
    }, []);

    useEffect(() => {
        loadThemes();
    }, [loadThemes]);

    const doInstall = useCallback(
        async (vm: ThemeMarketViewModel, useAfterInstall: boolean) => {
            store.set(installingHashAtom, (prev) => new Set(prev).add(vm.installKey));
            try {
                const existingLocal = installedPacks.find(
                    (pack) => pack.name === vm.item.name && !pack.builtin,
                );

                const tp =
                    vm.kind === 'remote'
                        ? await themePack.installRemoteThemePack(vm.srcUrl, existingLocal?.hash)
                        : await themePack.installThemePackFromDirectory(
                              vm.item.sourcePath,
                              existingLocal?.hash,
                          );

                if (!tp) {
                    showToast(t('theme.install_theme_fail', { reason: 'unknown' }), {
                        type: 'warn',
                    });
                    throw new Error('install returned null');
                }

                showToast(t('theme.install_theme_success', { name: tp.name }));
                if (useAfterInstall) {
                    await themePack.selectTheme(tp);
                }
            } catch (err) {
                showToast(
                    t('theme.install_theme_fail', {
                        reason: vm.kind === 'remote' ? 'network' : 'unknown',
                    }),
                    { type: 'warn' },
                );
                throw err;
            } finally {
                store.set(installingHashAtom, (prev) => {
                    const next = new Set(prev);
                    next.delete(vm.installKey);
                    return next;
                });
            }
        },
        [installedPacks, t],
    );

    const handleInstall = useCallback((vm: ThemeMarketViewModel) => doInstall(vm, true), [
        doInstall,
    ]);

    const handleSecondaryAction = useCallback(
        (vm: ThemeMarketViewModel) => doInstall(vm, false),
        [doInstall],
    );

    const handleUse = useCallback(async (installed: IThemePack) => {
        await themePack.selectTheme(installed);
    }, []);

    if (status !== RequestStatus.Done || themes.length === 0) {
        return (
            <StatusPlaceholder
                status={status}
                isEmpty={themes.length === 0}
                errorTitle={t('theme.load_remote_theme_error')}
                onRetry={() => {
                    store.set(remoteStatusAtom, RequestStatus.Idle);
                    loadThemes();
                }}
                emptyTitle={t('theme.remote_theme_empty')}
            />
        );
    }

    return (
        <div className="remote-themes">
            <p className="remote-themes__submit-hint">
                <Trans
                    i18nKey="theme.how_to_submit_new_theme"
                    components={{
                        Github: <A href={GITHUB_REPO_URL}>{''}</A>,
                    }}
                />
            </p>
            {allTags.length > 0 && (
                <div className="remote-themes__filter-bar">
                    <Chip
                        label={t('theme.filter_all')}
                        active={activeTag === null}
                        onClick={() => setActiveTag(null)}
                    />
                    {allTags.map((tag) => (
                        <Chip
                            key={tag}
                            label={tag}
                            active={activeTag === tag}
                            onClick={() => setActiveTag(tag)}
                        />
                    ))}
                </div>
            )}
            <div className="remote-themes__grid">
                {filteredThemes.map((vm) => {
                    const installed = installedPacks.find((pack) => pack.name === vm.item.name);
                    const isActive = currentPack?.name === vm.item.name;
                    const hasUpdate =
                        vm.kind === 'remote' &&
                        !!installed &&
                        !installed.builtin &&
                        (installed.version && vm.item.version
                            ? installed.version !== vm.item.version
                            : installed.hash !== vm.item.hash);
                    const needsInstall = !installed || hasUpdate;
                    const isInstalling = installingHashes.has(vm.installKey);
                    const installLabel = hasUpdate
                        ? t('theme.update_theme')
                        : installed
                          ? t('theme.use_theme')
                          : vm.kind === 'remote'
                            ? t('theme.download_and_use')
                            : t('theme.install_theme');
                    const secondaryLabel = hasUpdate
                        ? t('theme.update_only')
                        : vm.kind === 'remote'
                          ? t('theme.download_only')
                          : t('theme.install_theme');

                    return (
                        <ThemeCard
                            key={vm.key}
                            name={vm.item.name}
                            author={vm.item.author}
                            active={isActive}
                            preview={
                                <ThemePreview
                                    preview={vm.previewUrl}
                                    name={vm.item.name}
                                    isActive={isActive}
                                    isNew={vm.item.isNew}
                                />
                            }
                            footer={
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    loading={isInstalling}
                                    icon={
                                        needsInstall ? (
                                            <Download width={14} height={14} />
                                        ) : (
                                            <Palette width={14} height={14} />
                                        )
                                    }
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (installed && !hasUpdate) {
                                            handleUse(installed);
                                        } else {
                                            handleSecondaryAction(vm);
                                        }
                                    }}
                                >
                                    {installed && !hasUpdate ? t('theme.use_theme') : secondaryLabel}
                                </Button>
                            }
                            onClick={() => {
                                if (isInstalling) return;
                                showModal('ThemeDetailModal', {
                                    name: vm.item.name,
                                    author: vm.item.author,
                                    authorUrl: vm.item.authorUrl,
                                    description: vm.item.description,
                                    version: vm.item.version,
                                    preview: vm.previewUrl,
                                    onInstall:
                                        installed && !hasUpdate
                                            ? () => handleUse(installed)
                                            : () => handleInstall(vm),
                                    installLabel,
                                    needsDownload: vm.kind === 'remote' && needsInstall,
                                    ...(vm.kind === 'remote' &&
                                        needsInstall && {
                                            onDownloadOnly: () => handleSecondaryAction(vm),
                                            downloadOnlyLabel: secondaryLabel,
                                        }),
                                });
                            }}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                showContextMenu(
                                    'RemoteThemeMenu',
                                    { x: e.clientX, y: e.clientY },
                                    {
                                        name: vm.item.name,
                                        author: vm.item.author,
                                        authorUrl: vm.item.authorUrl,
                                        description: vm.item.description,
                                        version: vm.item.version,
                                        preview: vm.previewUrl,
                                        onInstall:
                                            installed && !hasUpdate
                                                ? () => handleUse(installed)
                                                : () => handleInstall(vm),
                                        installLabel,
                                        needsDownload: vm.kind === 'remote' && needsInstall,
                                        ...(vm.kind === 'remote' &&
                                            needsInstall && {
                                                onDownloadOnly: () => handleSecondaryAction(vm),
                                                downloadOnlyLabel: secondaryLabel,
                                            }),
                                    },
                                );
                            }}
                        />
                    );
                })}
            </div>
        </div>
    );
}
