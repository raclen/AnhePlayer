import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsCard } from '../components/SettingsCard';
import { Button } from '@renderer/mainWindow/components/ui/Button';
import { A } from '@renderer/mainWindow/components/ui/A';
import systemUtil from '@infra/systemUtil/renderer';
import { showModal } from '@renderer/mainWindow/components/ui/Modal/modalManager';
import { Github, type LucideIcon } from 'lucide-react';

const GITHUB_REPO = 'https://github.com/raclen/AnhePlayer';
const GITHUB_AUTHOR = 'https://github.com/raclen';
const GITHUB_ISSUES = 'https://github.com/raclen/AnhePlayer/issues';
const OFFICIAL_SITE = 'https://github.com/raclen/AnhePlayer';
const LICENSE_URL = `${GITHUB_REPO}/blob/master/LICENSE`;

const SOCIAL_LINKS_DATA: {
    icon: LucideIcon;
    label: string;
    handle: string;
    url: string;
}[] = [{ icon: Github, label: 'GitHub', handle: '@raclen', url: GITHUB_AUTHOR }];

export function AboutSection() {
    const { t } = useTranslation();
    const [updateStatus, setUpdateStatus] = useState<string>('');
    const [checking, setChecking] = useState(false);

    const handleCheckUpdate = useCallback(async () => {
        setChecking(true);
        setUpdateStatus('');
        try {
            const info = await systemUtil.checkUpdate();
            if (info.update) {
                showModal('UpdateModal', { updateInfo: info.update });
            } else {
                setUpdateStatus(t('settings.about.already_latest_v2'));
            }
        } catch {
            setUpdateStatus(t('settings.about.check_update_failed'));
        } finally {
            setChecking(false);
        }
    }, []);

    return (
        <>
            {/* 关于 */}
            <SettingsCard
                title={t('settings.about.title')}
                subtitle={t('settings.about.subtitle')}
                action={
                    <div className="p-setting__action-row">
                        {updateStatus && (
                            <span className="p-setting__action-hint">{updateStatus}</span>
                        )}
                        <Button
                            variant="secondary"
                            size="sm"
                            loading={checking}
                            onClick={handleCheckUpdate}
                        >
                            {t('settings.about.check_update_btn')}
                        </Button>
                    </div>
                }
            >
                <div className="p-setting__about-grid">
                    <div className="p-setting__about-column">
                        <InfoRow
                            label={t('settings.about.current_version_label')}
                            value={`v${globalContext.appVersion}`}
                        />
                        <LinkRow label="License" text="AGPL-3.0" url={LICENSE_URL} />
                        <AuthorRow />
                    </div>
                    <div className="p-setting__about-column">
                        <LinkRow
                            label={t('settings.about.official_site_link')}
                            text="github.com/raclen/AnhePlayer"
                            url={OFFICIAL_SITE}
                        />
                        <LinkRow label="GitHub" text="AnhePlayer" url={GITHUB_REPO} />
                        <LinkRow
                            label={t('settings.about.issues_link')}
                            text="GitHub Issues"
                            url={GITHUB_ISSUES}
                        />
                    </div>
                </div>
            </SettingsCard>

            {/* 联系作者 */}
            <SettingsCard
                title={t('settings.about.contact_author_title')}
                subtitle={t('settings.about.contact_author_subtitle')}
            >
                <div className="p-setting__about-contact-body">
                    <div className="p-setting__about-social-list">
                        {SOCIAL_LINKS_DATA.map((item) => (
                            <SocialChip key={item.label} {...item} />
                        ))}
                    </div>
                </div>
            </SettingsCard>
        </>
    );
}

function SocialChip({
    icon: Icon,
    label,
    handle,
    url,
}: {
    icon: LucideIcon;
    label: string;
    handle: string;
    url: string;
}) {
    return (
        <A href={url} className="p-setting__about-social-chip">
            <Icon size={16} className="p-setting__about-social-chip-icon" />
            <span className="p-setting__about-social-chip-label">{label}</span>
            <span className="p-setting__about-social-chip-handle">{handle}</span>
        </A>
    );
}

function InfoRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="p-setting__info-row">
            <span className="p-setting__info-label">{label}</span>
            <span className="p-setting__info-value">{value}</span>
        </div>
    );
}

function AuthorRow() {
    const { t } = useTranslation();

    return (
        <div className="p-setting__info-row">
            <span className="p-setting__info-label">{t('settings.about.author_label')}</span>
            <A href={GITHUB_AUTHOR} className="p-setting__info-value p-setting__author-value">
                {t('settings.about.author_name')}
            </A>
        </div>
    );
}

function LinkRow({ label, text, url }: { label: string; text: string; url: string }) {
    return (
        <div className="p-setting__info-row">
            <span className="p-setting__info-label">{label}</span>
            <A href={url}>{text}</A>
        </div>
    );
}
