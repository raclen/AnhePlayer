import { Activity, Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { Badge } from '@renderer/mainWindow/components/ui/Badge';
import { showModal } from '@renderer/mainWindow/components/ui/Modal/modalManager';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import { usePlugins, useActiveSourceHash } from '@infra/pluginManager/renderer/hooks';
import pluginManager from '@infra/pluginManager/renderer';
import { LOCAL_PLUGIN_HASH } from '@common/constant';
import PluginList from './components/PluginList';
import './index.scss';

/**
 * PluginManagerPage — 插件管理页面
 *
 * 顶部固定标题 + 操作栏，下方为可拖拽排序的插件列表。
 * 设计稿还原：Plugins.tsx (设计稿)
 */
export default function PluginManagerPage() {
    const { t } = useTranslation();
    const plugins = usePlugins();
    const activeSourceHash = useActiveSourceHash();
    const activePlugin = useMemo(
        () =>
            plugins.find((p) => p.sourceHash === activeSourceHash && p.hash !== LOCAL_PLUGIN_HASH),
        [plugins, activeSourceHash],
    );
    const pluginCount = useMemo(
        () => plugins.filter((p) => p.hash !== LOCAL_PLUGIN_HASH).length,
        [plugins],
    );
    const [checking, setChecking] = useState(false);

    /** 检测列表中全部音源是否可用 */
    const handleCheckSources = useCallback(async () => {
        const hashes = plugins.filter((p) => p.hash !== LOCAL_PLUGIN_HASH).map((p) => p.hash);
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
    }, [plugins, t]);

    return (
        <div className="p-plugin-manager">
            {/* 头部：标题 + 操作按钮 */}
            <div className="p-plugin-manager__header">
                <div className="p-plugin-manager__title-group">
                    <h2 className="p-plugin-manager__title">{t('plugin.plugin_management')}</h2>
                    {activePlugin && (
                        <Badge variant="tint" colorScheme="primary">
                            {`当前音源：${activePlugin.sourceName || activePlugin.platform}`}
                        </Badge>
                    )}
                    {pluginCount > 0 && (
                        <span className="p-plugin-manager__count">
                            {t('plugin.plugin_count', { count: pluginCount })}
                        </span>
                    )}
                </div>
                <div className="p-plugin-manager__header-actions">
                    <Button
                        variant="secondary"
                        size="md"
                        icon={<Activity size={16} />}
                        loading={checking}
                        disabled={pluginCount === 0}
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

            {/* 插件列表 */}
            <div className="p-plugin-manager__body">
                <PluginList />
            </div>
        </div>
    );
}
