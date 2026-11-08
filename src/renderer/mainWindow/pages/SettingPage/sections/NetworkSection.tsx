import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { SettingsCard } from '../components/SettingsCard';
import { SettingRow } from '../components/SettingRow';
import { Toggle } from '@renderer/mainWindow/components/ui/Toggle';
import { Input } from '@renderer/mainWindow/components/ui/Input';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { useConfigValue } from '@renderer/common/hooks/useConfigValue';
import { useBufferedConfigInput } from '../hooks/useBufferedConfigInput';
import systemUtil from '@infra/systemUtil/renderer';

/**
 * 网络设置
 *
 * 配置项：network.proxy.*
 * 默认直连；填写 HTTP 代理后原生请求立即生效，网页请求需重启应用（WebView2 启动参数）。
 */
export function NetworkSection() {
    const { t } = useTranslation();
    const [proxyEnabled, setProxyEnabled] = useConfigValue('network.proxy.enabled');

    const host = useBufferedConfigInput('network.proxy.host');
    const port = useBufferedConfigInput('network.proxy.port');
    const username = useBufferedConfigInput('network.proxy.username');
    const password = useBufferedConfigInput('network.proxy.password');

    const isDisabled = !proxyEnabled;

    return (
        <SettingsCard
            title={t('settings.section_name.network')}
            subtitle={t('settings.network.subtitle')}
        >
            <SettingRow
                label={t('settings.network.enable_proxy_label')}
                description={t('settings.network.enable_proxy_desc')}
                control={<Toggle checked={proxyEnabled ?? false} onChange={setProxyEnabled} />}
            />
            <SettingRow
                label={t('settings.network.host_label')}
                description={t('settings.network.host_desc')}
                control={
                    <Input
                        disabled={isDisabled}
                        value={host.localValue}
                        onChange={host.handleChange}
                        onBlur={host.handleBlur}
                        placeholder="127.0.0.1"
                    />
                }
            />
            <SettingRow
                label={t('settings.network.port_label')}
                description={t('settings.network.port_desc')}
                control={
                    <Input
                        disabled={isDisabled}
                        value={port.localValue}
                        onChange={port.handleChange}
                        onBlur={port.handleBlur}
                        placeholder="7890"
                    />
                }
            />
            <SettingRow
                label={t('settings.network.username_label')}
                description={t('settings.network.username_desc')}
                control={
                    <Input
                        disabled={isDisabled}
                        value={username.localValue}
                        onChange={username.handleChange}
                        onBlur={username.handleBlur}
                        placeholder={t('settings.network.username_placeholder')}
                    />
                }
            />
            <SettingRow
                label={t('settings.network.password_label')}
                description={t('settings.network.password_desc')}
                control={
                    <Input
                        disabled={isDisabled}
                        value={password.localValue}
                        onChange={password.handleChange}
                        onBlur={password.handleBlur}
                        placeholder={t('settings.network.password_placeholder')}
                        type="password"
                    />
                }
            />
            <div className="p-setting__action-row">
                <Button
                    variant="secondary"
                    size="sm"
                    icon={<RotateCcw width={16} height={16} />}
                    onClick={() => systemUtil.restartApp()}
                >
                    {t('settings.network.restart')}
                </Button>
            </div>
        </SettingsCard>
    );
}
