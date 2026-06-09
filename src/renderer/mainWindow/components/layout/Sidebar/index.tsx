// ============================================================================
// Sidebar — 侧边栏
// ============================================================================

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Clock,
    Flame,
    Trophy,
    HardDrive,
    Download,
    Plus,
    Blocks,
    Palette,
    Settings,
    FlaskConical,
    PictureInPicture2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router';
import { useMusicSheetList, useStarredSheets } from '@infra/musicSheet/renderer';
import systemUtil from '@infra/systemUtil/renderer';
import { showModal } from '../../ui/Modal/modalManager';
import { RoutePaths } from '../../../routes';
import type { RoutePath } from '../../../routes';
import LocalSheetNavItem from './LocalSheetNavItem';
import StarredSheetNavItem from './StarredSheetNavItem';
import './index.scss';

const BRAND_NAME = 'Anhe';

// 底部工具按钮: icon + route + i18n key
const FOOTER_TOOLS: { key: RoutePath; icon: LucideIcon; titleKey: string }[] = [
    { key: RoutePaths.PluginManager, icon: Blocks, titleKey: 'plugin.plugin_management' },
    { key: RoutePaths.Theme, icon: Palette, titleKey: 'theme.title' },
    { key: RoutePaths.Setting, icon: Settings, titleKey: 'settings.title' },
];

export default function Sidebar() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const sheets = useMusicSheetList();
    const starredSheets = useStarredSheets();

    /** 当前路径的第一段，用于匹配静态导航项高亮 */
    const activeSegment = location.pathname.split('/')[1] ?? '';

    const handleCreateSheet = useCallback(() => {
        showModal('CreateSheetModal');
    }, []);

    return (
        <aside className="l-sidebar">
            {/* ── Logo ── */}
            <div className="l-sidebar__logo" aria-label={BRAND_NAME} title={BRAND_NAME}>
                <span className="l-sidebar__logo-text">{BRAND_NAME}</span>
            </div>

            {/* ── 导航列表 ── */}
            <nav className="l-sidebar__nav" aria-label={t('app.nav_main')}>
                {/* 在线 */}
                <div className="l-sidebar__group">
                    <div className="l-sidebar__group-title">{t('app.nav_online')}</div>
                    <NavItem
                        route={RoutePaths.Toplist}
                        icon={Trophy}
                        text={t('toplist.title')}
                        activeSegment={activeSegment}
                        navigate={navigate}
                    />
                    <NavItem
                        route={RoutePaths.RecommendSheets}
                        icon={Flame}
                        text={t('playlist.recommend')}
                        activeSegment={activeSegment}
                        navigate={navigate}
                    />
                </div>
                {/* 本地 */}
                <div className="l-sidebar__group">
                    <div className="l-sidebar__group-title">{t('app.nav_local')}</div>
                    <NavItem
                        route={RoutePaths.LocalMusic}
                        icon={HardDrive}
                        text={t('local_music.title')}
                        activeSegment={activeSegment}
                        navigate={navigate}
                    />
                    <NavItem
                        route={RoutePaths.Download}
                        icon={Download}
                        text={t('download.title')}
                        activeSegment={activeSegment}
                        navigate={navigate}
                    />
                    <NavItem
                        route={RoutePaths.RecentlyPlayed}
                        icon={Clock}
                        text={t('history.title')}
                        activeSegment={activeSegment}
                        navigate={navigate}
                    />
                </div>

                {/* ── 创建的歌单 ── */}
                <div className="l-sidebar__group">
                    <div className="l-sidebar__group-header">
                        <div className="l-sidebar__group-title">{t('playlist.created_sheets')}</div>
                        <div className="l-sidebar__group-actions">
                            <button
                                className="l-sidebar__group-action"
                                type="button"
                                title={t('playlist.create_sheet')}
                                onClick={handleCreateSheet}
                            >
                                <Plus size={14} />
                            </button>
                        </div>
                    </div>
                    {sheets.length > 0 ? (
                        sheets.map((sheet) => (
                            <LocalSheetNavItem
                                key={sheet.id}
                                sheet={sheet}
                                pathname={location.pathname}
                                navigate={navigate}
                            />
                        ))
                    ) : (
                        <div className="l-sidebar__placeholder">{t('playlist.no_sheets')}</div>
                    )}
                </div>

                {/* ── 收藏的歌单 ── */}
                <div className="l-sidebar__group">
                    <div className="l-sidebar__group-title">{t('playlist.starred_sheets')}</div>
                    {starredSheets.length > 0 ? (
                        starredSheets.map((item) => (
                            <StarredSheetNavItem
                                key={`${item.platform}\0${item.id}`}
                                item={item}
                                pathname={location.pathname}
                                navigate={navigate}
                            />
                        ))
                    ) : (
                        <div className="l-sidebar__placeholder">{t('playlist.no_starred')}</div>
                    )}
                </div>
            </nav>

            {/* ── 底部工具栏 ── */}
            <div className="l-sidebar__footer">
                {FOOTER_TOOLS.map((tool) => (
                    <button
                        key={tool.key}
                        className={`l-sidebar__tool-btn${
                            activeSegment === tool.key ? ' is-active' : ''
                        }`}
                        type="button"
                        title={t(tool.titleKey)}
                        onClick={() => navigate(`/${tool.key}`)}
                    >
                        <tool.icon size={16} />
                    </button>
                ))}

                <button
                    className="l-sidebar__tool-btn"
                    type="button"
                    title={t('app.minimode')}
                    onClick={() => systemUtil.enterMinimode()}
                >
                    <PictureInPicture2 size={16} />
                </button>

                {/* 开发模式：组件展示入口 */}
                {__DEV__ && (
                    <button
                        className={`l-sidebar__tool-btn l-sidebar__tool-btn--dev${
                            activeSegment === RoutePaths.ComponentShowcase.split('/')[0]
                                ? ' is-active'
                                : ''
                        }`}
                        type="button"
                        title={t('app.component_showcase')}
                        onClick={() => navigate(`/${RoutePaths.ComponentShowcase}`)}
                    >
                        <FlaskConical size={16} />
                    </button>
                )}
            </div>
        </aside>
    );
}

/** Inline nav item — avoids map overhead for static items */
function NavItem({
    route,
    icon: Icon,
    text,
    activeSegment,
    navigate,
}: {
    route: RoutePath;
    icon: LucideIcon;
    text: string;
    activeSegment: string;
    navigate: (to: string) => void;
}) {
    return (
        <button
            className={`l-sidebar__nav-item${activeSegment === route ? ' is-active' : ''}`}
            type="button"
            onClick={() => navigate(`/${route}`)}
        >
            <Icon size={16} className="l-sidebar__nav-icon" />
            <span className="l-sidebar__nav-label">{text}</span>
        </button>
    );
}
