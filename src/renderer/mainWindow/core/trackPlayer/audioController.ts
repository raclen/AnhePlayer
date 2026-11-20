/**
 * AudioController — IAudioController 接口 + WebAudioController 实现
 *
 * 底层音频播放抽象，面向接口编程。
 * 当前实现：WebAudioController（HTMLAudioElement + HLS）
 * 未来扩展：MpvAudioController 等
 */
import EventEmitter from 'eventemitter3';
import Hls from 'hls.js';
import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';
import { PlayerState, ErrorReason } from '@common/constant';
import requestForwarder from '@infra/requestForwarder/renderer';
import type { IResolvedMediaSource } from './types';

// ─── 事件类型 ───

export interface IAudioControllerEvents {
    /** 播放状态变化 */
    stateChange: (state: PlayerState) => void;
    /** 播放进度更新 */
    timeUpdate: (progress: { currentTime: number; duration: number }) => void;
    /** 播放结束 */
    ended: () => void;
    /** 播放错误 */
    error: (reason: ErrorReason, detail?: any) => void;
    /** 音量变化 */
    volumeChange: (volume: number) => void;
    /** 速度变化 */
    speedChange: (speed: number) => void;
}

// ─── 接口定义 ───

/** 音频控制器接口 — 所有实现必须遵守 */
export interface IAudioController extends EventEmitter<IAudioControllerEvents> {
    /** 预准备（设置 MediaSession metadata，清空旧音源） */
    prepareTrack(musicItem: IMusicItemSlim): void;
    /** 设置音源并可选自动播放 */
    setTrackSource(source: IResolvedMediaSource, musicItem: IMusic.IMusicItem): void;
    play(): void;
    pause(): void;
    seekTo(seconds: number): void;
    reset(): void;
    destroy(): void;

    setVolume(volume: number): void;
    setSpeed(speed: number): void;
    setSinkId(deviceId: string): Promise<void>;

    readonly playerState: PlayerState;
    readonly hasSource: boolean;
}

// ─── WebAudioController 实现 ───

class WebAudioController extends EventEmitter<IAudioControllerEvents> implements IAudioController {
    private audio: HTMLAudioElement;
    private hls: Hls | null = null;
    private _playerState: PlayerState = PlayerState.None;
    private _sourceId = 0; // fetch 竞态守卫
    private _currentBlobUrl: string | null = null; // 追踪 blob URL 防止内存泄漏
    private playRequested = false;
    private sourceFailed = false;
    private pendingSeek: number | null = null;
    private progressTimer: ReturnType<typeof setInterval> | null = null;
    private lastPlaybackTime = 0;
    private lastProgressAt = 0;
    private readonly STALL_TIMEOUT = 15_000;

    get playerState(): PlayerState {
        return this._playerState;
    }

    get hasSource(): boolean {
        return !this.sourceFailed && !!this.audio.src && this.audio.src !== location.href;
    }

    constructor() {
        super();
        this.audio = new Audio();
        this.audio.preload = 'auto';
        this.audio.controls = false;
        this.bindEvents();
    }

    prepareTrack(musicItem: IMusicItemSlim): void {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: musicItem.title,
            artist: musicItem.artist,
            album: musicItem.album ?? undefined,
            artwork: musicItem.artwork ? [{ src: musicItem.artwork }] : undefined,
        });
        this._sourceId++;
        this.playRequested = false;
        this.sourceFailed = false;
        this.pendingSeek = null;
        this.stopProgressWatch();
        this.setPlayerState(PlayerState.None);
        this.destroyHls();
        this.revokeBlobUrl();
        this.audio.src = '';
        this.audio.removeAttribute('src');
        navigator.mediaSession.playbackState = 'none';
    }

    setTrackSource(source: IResolvedMediaSource, _musicItem: IMusic.IMusicItem): void {
        const sourceId = ++this._sourceId;
        this.playRequested = false;
        this.sourceFailed = false;
        this.pendingSeek = null;
        this.stopProgressWatch();
        this.destroyHls();
        this.revokeBlobUrl();

        // 从 URL 的 userinfo 部分提取 Basic Auth（如 http://user:pass@host/...）
        const { cleanUrl: url, authHeader } = this.extractBasicAuth(source.url!);
        let headers = this.buildHeaders(source);
        if (authHeader) {
            if (!headers) headers = {};
            headers['Authorization'] = authHeader;
        }

        // HLS 支持
        if (this.isHls(source)) {
            if (Hls.isSupported()) {
                this.initHls(() => {
                    if (this._sourceId !== sourceId || !this.playRequested) return;
                    this.playAudio();
                });
                if (headers) {
                    // HLS 请求由 hls.js 直连；相对分片必须保持原始清单 URL 作为解析基址。
                    this.hls!.config.xhrSetup = (xhr: XMLHttpRequest) => {
                        for (const [key, value] of Object.entries(headers)) {
                            xhr.setRequestHeader(key, value);
                        }
                    };
                }
                this.hls!.loadSource(url);
            } else {
                this.failPlayback(ErrorReason.UnsupportedResource);
            }
            return;
        }

        // 远程非 HLS：通过代理服务器播放，代理负责附加 headers 和跟随重定向。
        if (requestForwarder.isProxyRequired(url)) {
            const proxyUrl = requestForwarder.buildProxyUrl(
                url,
                headers ?? undefined,
                source.publicOnly === true,
            );
            if (proxyUrl !== url) {
                this.audio.src = proxyUrl;
                return;
            }

            if (!headers) {
                this.audio.src = url;
                return;
            }

            // 代理不可用且需要 headers 时，降级到 fetch。
            fetch(url, { method: 'GET', headers })
                .then((res) => {
                    if (!res.ok) throw new Error(`Audio HTTP ${res.status}`);
                    return res.blob();
                })
                .then((blob) => {
                    // 竞态守卫：fetch 期间可能已切歌
                    if (this._sourceId !== sourceId || this.sourceFailed) return;
                    this._currentBlobUrl = URL.createObjectURL(blob);
                    this.audio.src = this._currentBlobUrl;
                    if (this.playRequested) this.playAudio();
                })
                .catch((err) => {
                    if (this._sourceId !== sourceId) return;
                    this.failPlayback(ErrorReason.EmptyResource, err);
                });
            return;
        }

        this.audio.src = url;
    }

    play(): void {
        if (this.sourceFailed) return;
        if (!this.playRequested) {
            this.playRequested = true;
            this.startProgressWatch();
        }
        if (this.audio.paused || this.audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
            this.setPlayerState(PlayerState.Buffering);
        }
        if (this.hasSource) this.playAudio();
    }

    pause(): void {
        this.playRequested = false;
        this.stopProgressWatch();
        this.audio.pause();
        this.setPlayerState(PlayerState.Paused);
        navigator.mediaSession.playbackState = 'paused';
    }

    seekTo(seconds: number): void {
        if (!isFinite(seconds)) return;
        // 换源后 metadata 尚未到达，先保存进度，避免续播位置丢失。
        this.pendingSeek = Math.max(0, seconds);
        this.applyPendingSeek();
        this.markPlaybackProgress();
    }

    setVolume(volume: number): void {
        this.audio.volume = Math.max(0, Math.min(1, volume));
    }

    setSpeed(speed: number): void {
        this.audio.defaultPlaybackRate = speed;
        this.audio.playbackRate = speed;
    }

    setSinkId(deviceId: string): Promise<void> {
        return (this.audio as any).setSinkId(deviceId);
    }

    reset(): void {
        this._sourceId++;
        this.playRequested = false;
        this.sourceFailed = false;
        this.pendingSeek = null;
        this.stopProgressWatch();
        this.setPlayerState(PlayerState.None);
        this.destroyHls();
        this.revokeBlobUrl();
        this.audio.src = '';
        this.audio.removeAttribute('src');
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
    }

    destroy(): void {
        this.destroyHls();
        this.reset();
        this.removeAllListeners();
    }

    // ─── Private Methods ───

    private bindEvents(): void {
        this.audio.onplaying = () => {
            if (!this.playRequested || this.sourceFailed) return;
            this.markPlaybackProgress();
            this.setPlayerState(PlayerState.Playing);
            navigator.mediaSession.playbackState = 'playing';
        };

        this.audio.onpause = () => {
            if (!this.hasSource || !this.audio.paused) return;
            this.playRequested = false;
            this.stopProgressWatch();
            this.setPlayerState(PlayerState.Paused);
            navigator.mediaSession.playbackState = 'paused';
        };

        this.audio.onwaiting = () => {
            if (this.playRequested) this.setPlayerState(PlayerState.Buffering);
        };
        this.audio.onstalled = () => {
            // stalled 也会在预加载或仍有足够缓冲时出现，不能立即判为音源失效。
            if (this.playRequested && this.audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
                this.setPlayerState(PlayerState.Buffering);
            }
        };
        this.audio.onseeking = () => this.markPlaybackProgress();
        this.audio.onloadedmetadata = () => this.applyPendingSeek();

        this.audio.onerror = () => {
            this.failPlayback(ErrorReason.EmptyResource, { kind: 'media-error' });
        };

        this.audio.ontimeupdate = () => {
            if (this.pendingSeek !== null) return;
            this.emit('timeUpdate', {
                currentTime: this.audio.currentTime,
                duration: this.audio.duration,
            });
        };

        this.audio.onended = () => {
            if (this.sourceFailed) return;
            this.playRequested = false;
            this.stopProgressWatch();
            this.setPlayerState(PlayerState.Paused);
            navigator.mediaSession.playbackState = 'paused';
            this.emit('ended');
        };

        this.audio.onvolumechange = () => {
            this.emit('volumeChange', this.audio.volume);
        };

        this.audio.onratechange = () => {
            this.emit('speedChange', this.audio.playbackRate);
        };
    }

    private setPlayerState(state: PlayerState): void {
        if (this._playerState !== state) {
            this._playerState = state;
            this.emit('stateChange', state);
        }
    }

    private playAudio(): void {
        const sourceId = this._sourceId;
        this.audio.play().catch((error: DOMException) => {
            if (this._sourceId !== sourceId || !this.playRequested) return;
            // 切源/暂停导致的取消不是音源错误；自动播放限制也不能通过换源解决。
            if (error.name === 'AbortError') return;
            if (error.name === 'NotAllowedError') {
                this.pause();
                return;
            }
            this.failPlayback(ErrorReason.EmptyResource, {
                kind: 'play-rejected',
                name: error.name,
            });
        });
    }

    private applyPendingSeek(): void {
        if (this.pendingSeek === null || this.audio.readyState === HTMLMediaElement.HAVE_NOTHING)
            return;
        this.audio.currentTime = Math.min(this.pendingSeek, this.audio.duration || Infinity);
        this.pendingSeek = null;
    }

    private markPlaybackProgress(): void {
        this.lastPlaybackTime = this.audio.currentTime;
        this.lastProgressAt = performance.now();
    }

    private startProgressWatch(): void {
        this.stopProgressWatch();
        this.markPlaybackProgress();
        const sourceId = this._sourceId;
        this.progressTimer = setInterval(() => {
            if (this._sourceId !== sourceId || !this.playRequested) return;
            if (Math.abs(this.audio.currentTime - this.lastPlaybackTime) > 0.01) {
                this.markPlaybackProgress();
                return;
            }
            // timeupdate 在卡住时仍可能触发，必须检查播放位置是否真的推进。
            if (performance.now() - this.lastProgressAt >= this.STALL_TIMEOUT) {
                this.failPlayback(ErrorReason.EmptyResource, { kind: 'playback-stalled' });
            }
        }, 1000);
    }

    private stopProgressWatch(): void {
        if (this.progressTimer !== null) {
            clearInterval(this.progressTimer);
            this.progressTimer = null;
        }
    }

    private failPlayback(reason: ErrorReason, detail?: any): void {
        if (this.sourceFailed) return;
        this.sourceFailed = true;
        this.playRequested = false;
        this.stopProgressWatch();
        this.audio.pause();
        this.setPlayerState(PlayerState.Paused);
        navigator.mediaSession.playbackState = 'paused';
        // 不记录音源 URL 或请求头，避免签名与认证信息泄漏。
        console.warn('[AudioController] 播放失败', {
            reason,
            currentTime: this.audio.currentTime,
            readyState: this.audio.readyState,
            networkState: this.audio.networkState,
            mediaErrorCode: this.audio.error?.code,
        });
        this.emit('error', reason, detail);
    }

    // ─── HLS ───

    private initHls(onReady?: () => void): void {
        this.destroyHls();
        this.hls = new Hls();
        this.hls.attachMedia(this.audio);

        if (onReady) {
            this.hls.once(Hls.Events.MANIFEST_PARSED, onReady);
        }

        const sourceId = this._sourceId;
        this.hls.on(Hls.Events.ERROR, (_event: any, data: any) => {
            if (this._sourceId === sourceId && data.fatal) {
                this.failPlayback(ErrorReason.EmptyResource, data);
            }
        });
    }

    private destroyHls(): void {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
    }

    private isHls(source: IResolvedMediaSource): boolean {
        if (source.isHls === true) return true;
        const url = source.url ?? '';
        try {
            const pathname = new URL(url).pathname;
            return pathname.endsWith('.m3u8');
        } catch {
            return url.includes('.m3u8');
        }
    }

    private revokeBlobUrl(): void {
        if (this._currentBlobUrl) {
            URL.revokeObjectURL(this._currentBlobUrl);
            this._currentBlobUrl = null;
        }
    }

    /** 从 URL 的 userinfo 部分提取 Basic Auth 凭证 */
    private extractBasicAuth(url: string): { cleanUrl: string; authHeader?: string } {
        try {
            const parsed = new URL(url);
            if (parsed.username) {
                const auth =
                    'Basic ' +
                    btoa(
                        decodeURIComponent(parsed.username) +
                            ':' +
                            decodeURIComponent(parsed.password),
                    );
                parsed.username = '';
                parsed.password = '';
                return { cleanUrl: parsed.href, authHeader: auth };
            }
        } catch {
            /* not a valid URL, skip */
        }
        return { cleanUrl: url };
    }

    private buildHeaders(source: IResolvedMediaSource): Record<string, string> | null {
        const headers: Record<string, string> = {};
        if (source.headers) {
            Object.assign(headers, source.headers);
        }
        if (source.userAgent) {
            headers['User-Agent'] = source.userAgent;
        }
        return Object.keys(headers).length > 0 ? headers : null;
    }
}

// ─── 工厂模式 ───

export type AudioControllerFactory = () => IAudioController;

const controllerFactories: Record<string, AudioControllerFactory> = {
    'web-audio': () => new WebAudioController(),
    // 未来：
    // 'mpv': () => new MpvAudioController(),
};

export function createAudioController(type = 'web-audio'): IAudioController {
    const factory = controllerFactories[type];
    if (!factory) throw new Error(`Unknown audio controller: ${type}`);
    return factory();
}
