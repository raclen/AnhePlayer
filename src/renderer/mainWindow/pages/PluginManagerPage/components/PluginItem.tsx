import { memo, useCallback, useMemo, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
    GripVertical,
    HelpCircle,
    ArrowUpCircle,
    ArrowRightLeft,
    Sparkles,
    ListPlus,
    SlidersHorizontal,
    Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { Badge } from '@renderer/mainWindow/components/ui/Badge';
import { Toggle } from '@renderer/mainWindow/components/ui/Toggle';
import { showModal } from '@renderer/mainWindow/components/ui/Modal/modalManager';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import pluginManager from '@infra/pluginManager/renderer';
import type { ISourceGroup } from '@infra/pluginManager/renderer/hooks';
import type { IPluginAvailabilityResult } from '@infra/pluginManager/renderer';
import { cn } from '@common/cn';

// ── 方法名到 i18n key 的映射 ──

const METHOD_LABEL_MAP: Record<string, string> = {
    search: 'plugin.method_search',
    importMusicItem: 'plugin.method_import_music_item',
    importMusicSheet: 'plugin.method_import_music_sheet',
    getTopLists: 'plugin.method_get_top_lists',
    getLyric: 'plugin.method_get_lyric',
    getRecommendSheetTags: 'plugin.method_get_recommend_sheet_tags',
};

const noAnimateLayoutChanges = () => false;

export interface PluginItemProps {
    sourceGroup: ISourceGroup;
    availability?: IPluginAvailabilityResult;
    onToggleEnabled: (sourceHash: string, enabled: boolean) => void;
}

/** 音源可用性状态徽章 */
function AvailabilityBadge({ availability }: { availability?: IPluginAvailabilityResult }) {
    const { t } = useTranslation();

    switch (availability?.state) {
        case 'available':
            return <Badge variant="tint">{t('plugin.source_available')}</Badge>;
        case 'unavailable':
            return (
                <Badge variant="tint" colorScheme="danger" title={availability.message}>
                    {t('plugin.source_unavailable')}
                </Badge>
            );
        case 'checking':
            return (
                <Badge variant="outline" colorScheme="warn">
                    {t('plugin.source_checking')}
                </Badge>
            );
        case 'unsupported':
            return (
                <Badge variant="outline" colorScheme="warn">
                    {t('plugin.source_unsupported')}
                </Badge>
            );
        default:
            return <Badge variant="outline">{t('plugin.source_unchecked')}</Badge>;
    }
}

/**
 * PluginItem — 单个音源卡片（以音源包为维度，对齐移动端结构）
 */
function PluginItem({ sourceGroup, availability, onToggleEnabled }: PluginItemProps) {
    const { t } = useTranslation();

    const {
        attributes,
        listeners,
        setNodeRef,
        setActivatorNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({
        id: sourceGroup.sourceHash,
        animateLayoutChanges: noAnimateLayoutChanges,
    });

    const style = useMemo(
        () => ({
            transform: CSS.Transform.toString(
                transform ? { ...transform, scaleX: 1, scaleY: 1 } : null,
            ),
            transition,
            zIndex: isDragging ? 10 : undefined,
            opacity: isDragging ? 0.6 : 1,
        }),
        [transform, transition, isDragging],
    );

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={cn(
                'p-plugin-manager__item',
                isDragging && 'is-dragging',
                !sourceGroup.enabled && 'is-disabled',
            )}
        >
            {/* 第一行：拖拽手柄 + 基本信息 + 右侧操作 */}
            <div className="p-plugin-manager__item-main">
                <div
                    role="button"
                    tabIndex={-1}
                    ref={setActivatorNodeRef}
                    className="p-plugin-manager__drag-handle"
                    aria-label={t('plugin.drag_sort')}
                    {...attributes}
                    {...listeners}
                >
                    <GripVertical size={16} />
                </div>

                <PluginItemInfo
                    sourceGroup={sourceGroup}
                    availability={availability}
                    onToggleEnabled={onToggleEnabled}
                />
            </div>

            {/* 第二行：操作按钮 */}
            <PluginItemActions sourceGroup={sourceGroup} />
        </div>
    );
}

// ── 信息区 + 切换与开关 ──

const PluginItemInfo = memo(function PluginItemInfo({
    sourceGroup,
    availability,
    onToggleEnabled,
}: PluginItemProps) {
    const { t } = useTranslation();

    // ── 能力标签：支持xx/xx/xx功能 ──
    const capabilities = useMemo(() => {
        const labels = sourceGroup.supportedMethods
            .filter((m) => m in METHOD_LABEL_MAP)
            .map((m) => t(METHOD_LABEL_MAP[m]));
        if (labels.length === 0) return '';
        return t('plugin.supports_features', { features: labels.join('/') });
    }, [sourceGroup.supportedMethods, t]);

    const mainDelegate = sourceGroup.delegates[0];

    const handleDescription = useCallback(() => {
        if (mainDelegate) {
            showModal('PluginDescriptionModal', { plugin: mainDelegate });
        }
    }, [mainDelegate]);

    const handleSwitchActive = useCallback(async () => {
        await pluginManager.setActiveSourceHash(sourceGroup.sourceHash);
        showToast(`已切换为当前音源：${sourceGroup.name}`);
    }, [sourceGroup.sourceHash, sourceGroup.name]);

    return (
        <>
            <div className="p-plugin-manager__item-info">
                <div className="p-plugin-manager__item-title-row">
                    <h3 className="p-plugin-manager__item-name" title={sourceGroup.name}>
                        {sourceGroup.name}
                    </h3>
                    {sourceGroup.isActive && <Badge variant="tint">使用中</Badge>}
                    <AvailabilityBadge availability={availability} />
                    {sourceGroup.version && (
                        <span className="p-plugin-manager__item-version">
                            {`v${sourceGroup.version.replace(/^v/i, '')}`}
                        </span>
                    )}
                    {sourceGroup.description && (
                        <button
                            type="button"
                            className="p-plugin-manager__help-btn"
                            onClick={handleDescription}
                            aria-label={t('plugin.plugin_description')}
                        >
                            <HelpCircle size={16} />
                        </button>
                    )}
                </div>

                {/* 平台支持胶囊列表 */}
                {sourceGroup.platformNames.length > 0 && (
                    <div className="p-plugin-manager__platforms">
                        {sourceGroup.platformNames.map((pName) => (
                            <Badge key={pName} variant="outline">
                                {pName}
                            </Badge>
                        ))}
                    </div>
                )}

                <p className="p-plugin-manager__item-meta">
                    {sourceGroup.author && <span>{sourceGroup.author}</span>}
                    {sourceGroup.author && capabilities && <span> · </span>}
                    {capabilities && <span>{capabilities}</span>}
                </p>
            </div>

            <div className="p-plugin-manager__item-right">
                {!sourceGroup.isActive && (
                    <Button
                        variant="secondary"
                        size="sm"
                        icon={<ArrowRightLeft size={14} />}
                        onClick={handleSwitchActive}
                    >
                        切换
                    </Button>
                )}
                <Toggle
                    checked={sourceGroup.enabled}
                    onChange={(checked) => onToggleEnabled(sourceGroup.sourceHash, checked)}
                    aria-label={t('plugin.toggle_enable')}
                />
            </div>
        </>
    );
});

// ── 操作按钮行 ──

const PluginItemActions = memo(function PluginItemActions({
    sourceGroup,
}: {
    sourceGroup: ISourceGroup;
}) {
    const { t } = useTranslation();
    const mainDelegate = sourceGroup.delegates[0];
    const hasUpdateSource = !!sourceGroup.srcUrl;
    const [updating, setUpdating] = useState(false);

    const handleUpdate = useCallback(async () => {
        if (!mainDelegate) return;
        setUpdating(true);
        try {
            const result = await pluginManager.updatePlugin(mainDelegate.hash);
            if (result.success) {
                showToast(`音源 ${sourceGroup.name} 更新成功`);
            } else {
                showToast(`音源 ${sourceGroup.name} 已是最新版本`);
            }
        } catch {
            showToast(t('plugin.update_failed'), { type: 'warn' });
        } finally {
            setUpdating(false);
        }
    }, [mainDelegate, sourceGroup.name, t]);

    const handleUninstall = useCallback(() => {
        showModal('ConfirmModal', {
            title: '卸载音源',
            message: '卸载后该音源提供的所有平台播放与搜索能力将被移除。',
            description: `确定要卸载音源「${sourceGroup.name}」吗？`,
            confirmText: '确认卸载',
            confirmDanger: true,
            onConfirm: async () => {
                const result = await pluginManager.uninstallPlugin(sourceGroup.sourceHash);
                if (result.success) {
                    showToast(`已成功卸载音源：${sourceGroup.name}`);
                } else {
                    showToast(result.message ?? t('plugin.uninstall_failed'), {
                        type: 'warn',
                    });
                    throw new Error('uninstall failed');
                }
            },
        });
    }, [sourceGroup.sourceHash, sourceGroup.name, t]);

    const handleImportTrack = useCallback(() => {
        if (mainDelegate) {
            showModal('PluginImportModal', { plugin: mainDelegate, type: 'importMusicItem' });
        }
    }, [mainDelegate]);

    const handleImportSheet = useCallback(() => {
        if (mainDelegate) {
            showModal('PluginImportModal', { plugin: mainDelegate, type: 'importMusicSheet' });
        }
    }, [mainDelegate]);

    const handleUserVariables = useCallback(() => {
        if (mainDelegate) {
            showModal('PluginUserVariableModal', { plugin: mainDelegate });
        }
    }, [mainDelegate]);

    const handleSourceRedirect = useCallback(() => {
        if (mainDelegate) {
            showModal('PluginSourceRedirectModal', { plugin: mainDelegate });
        }
    }, [mainDelegate]);

    return (
        <div className="p-plugin-manager__item-actions">
            {sourceGroup.supportedMethods.includes('getMediaSource') && (
                <Button
                    variant="secondary"
                    size="sm"
                    icon={<ArrowRightLeft size={14} />}
                    onClick={handleSourceRedirect}
                >
                    {t('plugin.source_redirect')}
                </Button>
            )}
            {hasUpdateSource && (
                <Button
                    variant="secondary"
                    size="sm"
                    icon={<ArrowUpCircle size={14} />}
                    onClick={handleUpdate}
                    loading={updating}
                >
                    {t('plugin.update')}
                </Button>
            )}
            {sourceGroup.supportedMethods.includes('importMusicItem') && (
                <Button
                    variant="secondary"
                    size="sm"
                    icon={<Sparkles size={14} />}
                    onClick={handleImportTrack}
                >
                    {t('plugin.method_import_music_item')}
                </Button>
            )}
            {sourceGroup.supportedMethods.includes('importMusicSheet') && (
                <Button
                    variant="secondary"
                    size="sm"
                    icon={<ListPlus size={14} />}
                    onClick={handleImportSheet}
                >
                    {t('plugin.method_import_music_sheet')}
                </Button>
            )}
            {(mainDelegate?.userVariables?.length ?? 0) > 0 && (
                <Button
                    variant="secondary"
                    size="sm"
                    icon={<SlidersHorizontal size={14} />}
                    onClick={handleUserVariables}
                >
                    {t('plugin.prop_user_variable')}
                </Button>
            )}
            <Button
                variant="secondary"
                size="sm"
                danger
                icon={<Trash2 size={14} />}
                onClick={handleUninstall}
            >
                {t('plugin.uninstall')}
            </Button>
        </div>
    );
});

export default memo(PluginItem);
