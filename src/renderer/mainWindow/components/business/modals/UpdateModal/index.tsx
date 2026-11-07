import { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '@renderer/mainWindow/components/ui/Modal';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { CheckboxGroup } from '@renderer/mainWindow/components/ui/CheckboxGroup';
import { syncKV } from '@renderer/common/kvStore';
import systemUtil from '@infra/systemUtil/renderer';
import type { IUpdateInfo, IUpdateProgress } from '@appTypes/infra/systemUtil';
import { clearPendingUpdate } from '@renderer/mainWindow/common/updateNotice';
import { store, progressAtom } from '@renderer/mainWindow/core/trackPlayer/store';
import './index.scss';

export interface UpdateModalProps {
    close: () => void;
    /** 已发布的更新版本与说明 */
    updateInfo: NonNullable<IUpdateInfo['update']>;
}

type UpdatePhase = 'idle' | 'downloading' | 'verifying' | 'ready' | 'installing';

/**
 * UpdateModal — 软件更新提示弹窗（业务组件）
 *
 * 从侧栏角标或设置页打开，下载并校验后由用户确认安装，不自动打断播放。
 * 用户可勾选“不再提示此版本”，将版本号写入 localStorage，
 * 下次启动时跳过该版本（及更低版本）的提示。
 */
export default function UpdateModal({ close, updateInfo }: UpdateModalProps) {
    const { t } = useTranslation();
    const { version, changeLog } = updateInfo;
    const [phase, setPhase] = useState<UpdatePhase>(updateInfo.ready ? 'ready' : 'idle');
    const [progress, setProgress] = useState<IUpdateProgress | null>(null);
    const [error, setError] = useState('');
    const working = useRef(false);
    const busy = phase === 'downloading' || phase === 'verifying' || phase === 'installing';
    const [skipChecked, setSkipChecked] = useState(
        () => syncKV.get('update.skipVersion') === version,
    );

    const handleSkipChange = useCallback(
        (value: string[]) => {
            const checked = value.includes('skip');
            setSkipChecked(checked);
            if (checked) {
                syncKV.set('update.skipVersion', version);
                clearPendingUpdate();
            } else {
                syncKV.remove('update.skipVersion');
            }
        },
        [version],
    );

    const handleUpdate = async () => {
        if (working.current) return;
        working.current = true;
        setError('');
        const installing = phase === 'ready';
        try {
            if (installing) {
                setPhase('installing');
                // Windows 安装器直接结束旧进程，不能依赖 beforeunload 保存播放进度。
                syncKV.set('player.currentProgress', store.get(progressAtom).currentTime);
                await systemUtil.installUpdate(version);
                // Windows 成功后直接退出；不能在安装失败时清除更新提醒。
                clearPendingUpdate();
            } else {
                setProgress(null);
                setPhase('downloading');
                await systemUtil.downloadUpdate(version, (next) => {
                    setProgress(next);
                    setPhase(next.stage);
                });
                setPhase('ready');
            }
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
            setPhase(installing ? 'ready' : 'idle');
        } finally {
            working.current = false;
        }
    };

    const downloaded = (progress?.downloadedBytes ?? 0) / 1024 / 1024;
    const total = progress?.totalBytes;
    const percent = total
        ? Math.min(100, ((progress?.downloadedBytes ?? 0) / total) * 100)
        : undefined;
    const statusKey = {
        idle: 'app.update_hint',
        downloading: 'app.update_downloading',
        verifying: 'app.update_verifying',
        ready: 'app.update_ready',
        installing: 'app.update_installing',
    }[phase];

    return (
        <Modal
            open
            onClose={() => {
                if (!working.current) close();
            }}
            title={t('app.new_version_found', { version })}
            size="md"
            closable={!busy}
            closeOnBackdrop={!busy}
            closeOnEscape={!busy}
            footer={
                <div className="update-modal__footer">
                    <CheckboxGroup
                        value={skipChecked ? ['skip'] : []}
                        options={[{ value: 'skip', label: t('app.skip_version') }]}
                        onChange={handleSkipChange}
                        disabled={busy}
                    />
                    <div className="update-modal__actions">
                        <Button variant="primary" size="sm" loading={busy} onClick={handleUpdate}>
                            {t(
                                busy
                                    ? 'app.update_processing'
                                    : phase === 'ready'
                                      ? 'app.update_install'
                                      : error
                                        ? 'common.retry'
                                        : 'app.update_download',
                            )}
                        </Button>
                    </div>
                </div>
            }
        >
            {changeLog && changeLog.length > 0 && (
                <ul className="update-modal__changelog">
                    {changeLog.map((item, i) => (
                        <li key={i} className="update-modal__changelog-item">
                            {item}
                        </li>
                    ))}
                </ul>
            )}
            <div className="update-modal__status" role="status" aria-live="polite">
                {t(statusKey)}
            </div>
            {phase === 'downloading' && (
                <div className="update-modal__download">
                    <progress
                        className="update-modal__progress"
                        max={100}
                        value={percent}
                        aria-label={t('app.update_downloading')}
                    />
                    <div className="update-modal__transfer">
                        <span>
                            {downloaded.toFixed(1)} MB
                            {total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : ''}
                        </span>
                        <span>
                            {percent === undefined
                                ? t(
                                      downloaded > 0
                                          ? 'app.update_total_unknown'
                                          : 'app.update_connecting',
                                  )
                                : `${Math.floor(percent)}%`}
                        </span>
                    </div>
                    {!!progress?.attempt && (
                        <div className="update-modal__status">
                            {t('app.update_mirror', { index: progress.attempt })}
                        </div>
                    )}
                </div>
            )}
            {error && (
                <div className="update-modal__error" role="alert">
                    {error}
                </div>
            )}
        </Modal>
    );
}
