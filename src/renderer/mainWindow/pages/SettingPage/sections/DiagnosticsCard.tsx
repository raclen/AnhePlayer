import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import logger from '@infra/logger/renderer';
import fsUtil from '@infra/fsUtil/renderer';
import systemUtil from '@infra/systemUtil/renderer';
import type { IDiagnosticLogs } from '@appTypes/infra/logger';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import { showModal } from '@renderer/mainWindow/components/ui/Modal/modalManager';
import { SettingsCard } from '../components/SettingsCard';

export function DiagnosticsCard() {
    const { t } = useTranslation();
    const [snapshot, setSnapshot] = useState<IDiagnosticLogs | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const refresh = useCallback(async () => {
        setBusy(true);
        setError('');
        try {
            setSnapshot(await logger.readLogs());
        } catch {
            setError(t('diagnostics.read_failed'));
        } finally {
            setBusy(false);
        }
    }, [t]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const runAction = async (action: () => Promise<void>) => {
        setBusy(true);
        try {
            await action();
        } catch {
            showToast(t('diagnostics.action_failed'), { type: 'warn' });
        } finally {
            setBusy(false);
        }
    };

    const exportLogs = () =>
        runAction(async () => {
            const result = await systemUtil.showSaveDialog({
                title: t('diagnostics.export'),
                defaultPath: `AnhePlayer-playback-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
                filters: [{ name: t('diagnostics.file_type'), extensions: ['log'] }],
            });
            if (result.canceled || !result.filePath) return;
            const latest = await logger.readLogs();
            await fsUtil.writeFile(result.filePath, latest.content, { encoding: 'utf-8' });
            setSnapshot(latest);
            showToast(t('diagnostics.exported'));
        });

    const copyLogs = () =>
        runAction(async () => {
            const latest = await logger.readLogs();
            await navigator.clipboard.writeText(latest.content);
            setSnapshot(latest);
            showToast(t('common.copied'));
        });

    const clearLogs = () =>
        showModal('ConfirmModal', {
            title: t('diagnostics.clear'),
            message: t('diagnostics.clear_confirm'),
            confirmDanger: true,
            onConfirm: () =>
                runAction(async () => {
                    await logger.clearLogs();
                    setSnapshot(await logger.readLogs());
                    showToast(t('diagnostics.cleared'));
                }),
        });

    const openLogs = () =>
        runAction(async () => {
            const latest = await logger.readLogs();
            if (!(await systemUtil.showItemInFolder(latest.path)))
                throw new Error('Log file unavailable');
        });

    return (
        <SettingsCard title={t('diagnostics.title')} subtitle={t('diagnostics.description')}>
            <div className="p-setting__action-row p-setting__log-actions">
                <Button size="sm" variant="secondary" disabled={busy} onClick={exportLogs}>
                    {t('diagnostics.export')}
                </Button>
                <Button size="sm" variant="secondary" disabled={busy} onClick={copyLogs}>
                    {t('diagnostics.copy')}
                </Button>
                <Button size="sm" variant="secondary" disabled={busy} onClick={openLogs}>
                    {t('diagnostics.open')}
                </Button>
                <Button size="sm" variant="ghost" loading={busy} onClick={refresh}>
                    {t('diagnostics.refresh')}
                </Button>
                <Button size="sm" variant="ghost" danger disabled={busy} onClick={clearLogs}>
                    {t('diagnostics.clear')}
                </Button>
            </div>
            <p className="p-setting__action-hint">{t('diagnostics.privacy')}</p>
            {snapshot?.path && <p className="p-setting__log-path">{snapshot.path}</p>}
            {error && (
                <p className="p-setting__action-hint" role="status">
                    {error}
                </p>
            )}
            <pre className="p-setting__log-preview" aria-label={t('diagnostics.preview')}>
                {snapshot?.content.trim().split('\n').slice(-100).join('\n') ||
                    t('diagnostics.empty')}
            </pre>
        </SettingsCard>
    );
}
