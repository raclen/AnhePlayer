import { Activity, Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { Badge } from '@renderer/mainWindow/components/ui/Badge';
import { showModal } from '@renderer/mainWindow/components/ui/Modal/modalManager';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import { useSourceGroups } from '@infra/pluginManager/renderer/hooks';
import pluginManager from '@infra/pluginManager/renderer';
import PluginList from './components/PluginList';
import './index.scss';

/**
 * PluginManagerPage — 插件/音源管理页面
 *
 * 顶部固定标题 + 操作栏，下方为多音源列表与切换视图（对齐移动端多音源结构）。
 */
export default function PluginManagerPage() {
    const { t } = useTranslation();
    const sourceGroups = useSourceGroups();
    const activeSource = useMemo(
        () => sourceGroups.find((g) => g.isActive) || sourceGroups[0],
        [sourceGroups],
    );
    const sourceCount = sourceGroups.length;
    const [checking, setChecking] = useState(false);

    /** 检测列表中全部音源平台的可用性 */
    const handleCheckSources = useCallback(async () => {
        const hashes = sourceGroups.flatMap((g) => g.delegates.map((d) => d.hash));
        if (hashes.length === 0) return;

        setChecking(true);
        try {
            const summary = await pluginManager.checkPluginsAvailability(hashes);
            showToast(
                t('plugin.source_check_summary', {
                    available: summary.available,
                    unavailable: summary.unavailable,
                    unsupported: summary.unsupported,
                }),
            );
        } finally {
            setChecking(false);
        }
    }, [sourceGroups, t]);

    return (
        <div className="p-plugin-manager">
            {/* 头部：标题 + 操作按钮 */}
            <div className="p-plugin-manager__header">
                <div className="p-plugin-manager__title-group">
                    <h2 className="p-plugin-manager__title">{t('plugin.plugin_management')}</h2>
                    {activeSource && (
                        <Badge variant="tint" colorScheme="primary">
                            {`当前音源：${activeSource.name}`}
                        </Badge>
                    )}
                    {sourceCount > 0 && (
                        <span className="p-plugin-manager__count">
                            {`共 ${sourceCount} 个音源`}
                        </span>
                    )}
                </div>
                <div className="p-plugin-manager__header-actions">
                    <Button
                        variant="secondary"
                        size="md"
                        icon={<Activity size={16} />}
                        loading={checking}
                        disabled={sourceCount === 0}
                        onClick={handleCheckSources}
                    >
                        {t('plugin.check_source')}
                    </Button>
                    <Button
                        variant="primary"
                        size="md"
                        icon={<Plus size={16} />}
                        onClick={() => showModal('PluginInstallModal')}
                    >
                        {t('plugin.install_plugin')}
                    </Button>
                </div>
            </div>

            {/* 音源列表 */}
            <div className="p-plugin-manager__body">
                <PluginList />
            </div>
        </div>
    );
}
