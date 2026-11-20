import { memo, useCallback, useMemo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, HelpCircle, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { Badge } from '@renderer/mainWindow/components/ui/Badge';
import { Toggle } from '@renderer/mainWindow/components/ui/Toggle';
import { showModal } from '@renderer/mainWindow/components/ui/Modal/modalManager';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import pluginManager from '@infra/pluginManager/renderer';
import type { ISourceGroup } from '@infra/pluginManager/renderer/hooks';
import type {
    IPluginAvailabilityResult,
    PluginAvailabilityState,
} from '@infra/pluginManager/renderer';
import { cn } from '@common/cn';

// ── 检测状态到 i18n key 的映射 ──

const AVAILABILITY_LABEL_MAP: Record<PluginAvailabilityState, string> = {
    available: 'plugin.source_available',
    unavailable: 'plugin.source_unavailable',
    checking: 'plugin.source_checking',
    unsupported: 'plugin.source_unsupported',
    unchecked: 'plugin.source_unchecked',
};

const noAnimateLayoutChanges = () => false;

export interface PluginItemProps {
    sourceGroup: ISourceGroup;
    availability: Record<string, IPluginAvailabilityResult>;
    changingSource: boolean;
    onToggleEnabled: (sourceHash: string, enabled: boolean) => void;
}

/** 每个平台单独展示检测结果，不能用音源包的汇总状态代替。 */
function PlatformAvailabilityBadge({
    name,
    availability,
}: {
    name: string;
    availability?: IPluginAvailabilityResult;
}) {
    const { t } = useTranslation();
    const state = availability?.state ?? 'unchecked';
    const statusLabel = t(AVAILABILITY_LABEL_MAP[state]);
    const label = `${name}：${statusLabel}`;

    return (
        <Badge
            variant="outline"
            className={cn('p-plugin-manager__platform', `is-${state}`)}
            title={availability?.message ? `${label}（${availability.message}）` : label}
            aria-label={label}
            aria-busy={state === 'checking'}
        >
            {name}
        </Badge>
    );
}

/**
 * PluginItem — 单个音源卡片（以音源包为维度，对齐移动端结构）
 */
function PluginItem({
    sourceGroup,
    availability,
    changingSource,
    onToggleEnabled,
}: PluginItemProps) {
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
            {/* 拖拽手柄 + 基本信息 + 右侧操作 */}
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
                    changingSource={changingSource}
                    onToggleEnabled={onToggleEnabled}
                />
            </div>
        </div>
    );
}

// ── 信息区 + 卸载与音源使用开关 ──

const PluginItemInfo = memo(function PluginItemInfo({
    sourceGroup,
    availability,
    changingSource,
    onToggleEnabled,
}: PluginItemProps) {
    const { t } = useTranslation();
    const mainDelegate = sourceGroup.delegates[0];

    const handleDescription = useCallback(() => {
        if (mainDelegate) {
            showModal('PluginDescriptionModal', { plugin: mainDelegate });
        }
    }, [mainDelegate]);

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

    return (
        <>
            <div className="p-plugin-manager__item-info">
                <div className="p-plugin-manager__item-title-row">
                    <h3 className="p-plugin-manager__item-name" title={sourceGroup.name}>
                        {sourceGroup.name}
                    </h3>
                    {sourceGroup.isActive && <Badge variant="tint">使用中</Badge>}
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
                {sourceGroup.delegates.length > 0 && (
                    <div className="p-plugin-manager__platforms" aria-live="polite">
                        {sourceGroup.delegates.map((delegate, index) => (
                            <PlatformAvailabilityBadge
                                key={delegate.hash}
                                name={sourceGroup.platformNames[index] || delegate.platform}
                                availability={availability[delegate.hash]}
                            />
                        ))}
                    </div>
                )}

                {sourceGroup.author && (
                    <p className="p-plugin-manager__item-meta">{sourceGroup.author}</p>
                )}
            </div>

            <div className="p-plugin-manager__item-right">
                <Button
                    variant="secondary"
                    size="sm"
                    danger
                    icon={<Trash2 size={14} />}
                    onClick={handleUninstall}
                >
                    {t('plugin.uninstall')}
                </Button>
                <Toggle
                    checked={sourceGroup.isActive}
                    disabled={changingSource}
                    onChange={(checked) => onToggleEnabled(sourceGroup.sourceHash, checked)}
                    aria-label={t('plugin.toggle_enable')}
                />
            </div>
        </>
    );
});

export default memo(PluginItem);
