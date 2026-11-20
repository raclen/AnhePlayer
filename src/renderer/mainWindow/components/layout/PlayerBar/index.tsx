// ============================================================================
// PlayerBar — 底部播放栏
// ============================================================================

import { useEffect } from 'react';
import {
    SkipBack,
    SkipForward,
    Play,
    Pause,
    ListMusic,
    Maximize2,
    Shuffle,
    Loader2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DesktopLyric } from '@renderer/common/icons';
import { cn } from '@common/cn';
import { isRadioBrowserMedia } from '@common/radioBrowser';
import { PlayerState } from '@common/constant';
import trackPlayer from '@renderer/mainWindow/core/trackPlayer';
import appConfig from '@infra/appConfig/renderer';
import { useConfigValue } from '@renderer/common/hooks/useConfigValue';
import { FavoriteButton } from '../../business/FavoriteButton';
import { DownloadButton } from '../../business/DownloadButton';
import {
    useCurrentMusic,
    usePlayerState,
    useRepeatMode,
    usePlaybackSource,
} from '@renderer/mainWindow/core/trackPlayer/hooks';
import { REPEAT_MODE_MAP } from '@renderer/common/repeatModeMap';
import { Artwork } from '../../ui/Artwork';
import { Marquee } from '../../ui/Marquee';
import { toggleQueueDrawer } from '../QueueDrawer/queueDrawerState';
import { openFullscreenPlayer } from '../FullscreenPlayer/fullscreenPlayerState';
import { ProgressBar, TimeDisplay } from './ProgressBar';
import VolumePopover from './VolumePopover';
import SpeedPopover from './SpeedPopover';
import QualityPopover from './QualityPopover';
import './index.scss';

// ─── PlayerBar ───

/**
 * PlayerBar
 * @layer layout
 *
 * 底部固定播放栏，三列布局：
 * - 左侧：封面 + 歌曲信息（Marquee 滚动）
 * - 中间：播放控制（上/下一首、播放/暂停、播放模式、歌词）
 * - 右侧：音质、倍速气泡、音量气泡、播放列表
 *
 * 进度条独立为 ProgressBar 子组件隔离高频更新。
 * 音量、倍速各自独立为垂直气泡面板子组件。
 */
export default function PlayerBar() {
    const { t } = useTranslation();
    const currentMusic = useCurrentMusic();
    const playerState = usePlayerState();
    const repeatMode = useRepeatMode();
    const playbackSource = usePlaybackSource();

    const [enableDesktopLyric] = useConfigValue('lyric.enableDesktopLyric');

    const isPlaying = playerState === PlayerState.Playing;
    const isBuffering = playerState === PlayerState.Buffering;
    const isRadio = isRadioBrowserMedia(currentMusic);
    const hasMusic = currentMusic != null && !isRadio;
    const isLive = false;

    // 隔离防护：播放器仅供音乐使用，若存在历史电台条目立即清空
    useEffect(() => {
        if (isRadio) {
            trackPlayer.clearPlayback();
        }
    }, [isRadio]);

    // 优先展示实际播放来源：自动换源后可能与歌曲原始平台不同
    const displayPlatform = playbackSource?.platform ?? currentMusic?.platform;
    const sourceFallback = playbackSource?.fallback ?? false;

    const { Icon: RepeatIcon, tipKey: repeatTipKey } = REPEAT_MODE_MAP[repeatMode];

    return (
        <footer className="l-player-bar">
            {/* ── 进度条（独立组件，隔离高频更新） ── */}
            <ProgressBar />

            {/* ── 三列布局 ── */}
            <div className="l-player-bar__body">
                {/* ── 左侧: 歌曲信息（两行布局） ── */}
                <div className="l-player-bar__left">
                    <Artwork
                        src={currentMusic?.artwork ?? undefined}
                        size="sm"
                        rounded="sm"
                        className="l-player-bar__cover"
                        overlay={hasMusic ? <Maximize2 size={16} /> : undefined}
                        onClick={hasMusic ? openFullscreenPlayer : undefined}
                    />
                    <div className="l-player-bar__info">
                        {hasMusic ? (
                            <>
                                {/* 第一行: 歌名 · 歌手 · 来源 — 点击打开全屏播放器 */}
                                <Marquee
                                    className="l-player-bar__info-row"
                                    onClick={openFullscreenPlayer}
                                >
                                    <span className="l-player-bar__title">
                                        {currentMusic.title}
                                    </span>
                                    {currentMusic.artist && (
                                        <>
                                            <span className="l-player-bar__dot">·</span>
                                            <span className="l-player-bar__artist">
                                                {currentMusic.artist}
                                            </span>
                                        </>
                                    )}
                                    {displayPlatform && (
                                        <>
                                            <span className="l-player-bar__dot">·</span>
                                            <span
                                                className={cn(
                                                    'l-player-bar__source-badge',
                                                    sourceFallback && 'is-fallback',
                                                )}
                                                title={
                                                    sourceFallback
                                                        ? t('playback.source_fallback_hint', {
                                                              original:
                                                                  playbackSource?.originalPlatform,
                                                              platform: displayPlatform,
                                                          })
                                                        : undefined
                                                }
                                            >
                                                {sourceFallback && <Shuffle size={11} />}
                                                {isLive ? t('radio.live') : displayPlatform}
                                            </span>
                                        </>
                                    )}
                                </Marquee>
                                {/* 第二行: 喜欢、下载、分割线、时间 */}
                                <div className="l-player-bar__actions">
                                    <FavoriteButton musicItem={currentMusic} size="sm" />
                                    {!isLive && (
                                        <DownloadButton musicItem={currentMusic} size="sm" />
                                    )}
                                    <div className="l-player-bar__divider" />
                                    <TimeDisplay />
                                </div>
                            </>
                        ) : (
                            <span className="l-player-bar__empty-hint">
                                {t('playback.not_playing')}
                            </span>
                        )}
                    </div>
                </div>

                {/* ── 中间: 播放控制 ── */}
                <div className="l-player-bar__center">
                    {!isLive && (
                        <button
                            className={cn(
                                'l-player-bar__ctrl-btn',
                                enableDesktopLyric && 'is-active',
                            )}
                            type="button"
                            title={t('playback.desktop_lyric')}
                            onClick={() => {
                                appConfig.setConfig({
                                    'lyric.enableDesktopLyric': !enableDesktopLyric,
                                });
                            }}
                        >
                            <DesktopLyric size={15} />
                        </button>
                    )}
                    <button
                        className="l-player-bar__ctrl-btn l-player-bar__ctrl-btn--lg"
                        type="button"
                        title={t('playback.previous')}
                        onClick={() => trackPlayer.skipToPrev()}
                    >
                        <SkipBack size={17} fill="currentColor" />
                    </button>
                    <button
                        className="l-player-bar__ctrl-btn l-player-bar__ctrl-btn--play"
                        type="button"
                        title={
                            isBuffering
                                ? t('playback.buffering')
                                : isPlaying
                                  ? t('playback.pause')
                                  : t('playback.play')
                        }
                        onClick={() => trackPlayer.togglePlayPause()}
                    >
                        {isBuffering ? (
                            <Loader2 size={18} className="l-player-bar__buffering" />
                        ) : isPlaying ? (
                            <Pause size={18} fill="currentColor" />
                        ) : (
                            // 播放三角形视觉居中补偿 2px
                            <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />
                        )}
                    </button>
                    <button
                        className="l-player-bar__ctrl-btn l-player-bar__ctrl-btn--lg"
                        type="button"
                        title={t('playback.next')}
                        onClick={() => trackPlayer.skipToNext()}
                    >
                        <SkipForward size={17} fill="currentColor" />
                    </button>
                    {!isLive && (
                        <button
                            className="l-player-bar__ctrl-btn"
                            type="button"
                            title={t(repeatTipKey)}
                            onClick={() => trackPlayer.toggleRepeatMode()}
                        >
                            <RepeatIcon size={15} />
                        </button>
                    )}
                </div>

                {/* ── 右侧: 工具 ── */}
                <div className="l-player-bar__right">
                    {!isLive && (
                        <>
                            <QualityPopover />
                            <SpeedPopover />
                        </>
                    )}
                    <VolumePopover />

                    <div className="l-player-bar__divider l-player-bar__divider--tall" />
                    <button
                        className="l-player-bar__ctrl-btn"
                        data-click-outside-ignore
                        type="button"
                        title={t('playback.show_queue')}
                        onClick={toggleQueueDrawer}
                    >
                        <ListMusic size={15} />
                    </button>
                </div>
            </div>
        </footer>
    );
}
