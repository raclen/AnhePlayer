/**
 * appConfig — 默认配置值
 *
 * 提供应用配置的默认值，作为配置加载失败或重置时的回退。
 */
import type { IAppConfig } from '@appTypes/infra/appConfig';

const defaultAppConfig: IAppConfig = {
    '$schema-version': 1,
    'playMusic.whenQualityMissing': 'lower',
    'playMusic.defaultQuality': 'standard',
    'playMusic.clickMusicList': 'replace',
    'playMusic.caseSensitiveInSearch': false,
    'playMusic.playError': 'retry_with_source',
    'playMusic.whenDeviceRemoved': 'play',
    'radio.bitrate': 'all',
    'radio.countryCode': '',
    'radio.language': '',
    'normal.closeBehavior': 'minimize',
    'normal.checkUpdate': true,
    'normal.maxHistoryLength': 30,
    'download.defaultQuality': 'standard',
    'download.whenQualityMissing': 'lower',
    'download.filenameFormat': 'title-artist',
    'lyric.enableDesktopLyric': false,
    'lyric.alwaysOnTop': true,
    'lyric.lockLyric': false,
    'lyric.fontData': null,
    'lyric.fontColor': '#ffffff',
    'lyric.strokeColor': '#f5c542',
    'lyric.fontSize': 48,
    'lyric.autoMatch': true,
    'shortCut.enableLocal': true,
    'download.concurrency': 5,
    'normal.musicListHideColumns': ['duration'],
    'backup.resumeBehavior': 'append',
    'normal.language': 'zh-CN',
    'customize.brandName': '',
    'customize.hiddenNavItems': [],
    // 默认直连；用户可在设置 → 网络里手动填写 HTTP 代理
    'network.proxy.enabled': false,
    'network.proxy.host': '',
    'network.proxy.port': '',
    'network.proxy.username': '',
    'network.proxy.password': '',
};

export default defaultAppConfig;
