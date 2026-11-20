interface IQishuiHttpResult {
    status: number;
    data: any;
}

type QishuiRequest = (
    method: string,
    url: string,
    options: {
        headers: Record<string, string>;
        body?: any;
        timeout: number;
        responseType: string;
    },
) => Promise<IQishuiHttpResult>;

interface ISearchSession {
    id: string;
    cursors: Map<number, string>;
}

class QishuiResponseError extends Error {
    constructor(
        message: string,
        public readonly code?: number,
    ) {
        super(message);
    }
}

const API_PREFIX = '/api/luna/v1/platform';
const USER_AGENT = 'LunaOpenSDK/1.0.10';
// 搜索响应含完整目录信息；真实 Tauri HTTP 链路可能超过 15 秒，不能提前丢弃有效结果。
const REQUEST_TIMEOUT = 30000;
const COMMON_PARAMS = {
    aid: '765213',
    app_id: '765213',
    app_name: 'byte_autoservice_lite',
    version_code: '100010',
    version_name: '1.0.10',
    channel: 'bydSong',
    sdk_aid: '753999',
    caller_name: 'luna_open_sdk',
    sdk_version_code: '100000100',
    sdk_version_name: '0.0.1',
    sdk_channel: 'Test',
    vehicle_type: 'BYD',
    device_brand: 'BYD',
    device_type: 'BYD',
    device_platform: 'android',
    resolution: '1920x1080',
    os_version: '13',
    ac: 'wifi',
};

function checkedResponse(response: IQishuiHttpResult): Record<string, any> {
    if (response.status < 200 || response.status >= 300) {
        throw new QishuiResponseError(`汽水搜索请求失败（HTTP ${response.status}），请稍后重试`);
    }
    const data = response.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new QishuiResponseError('汽水搜索接口返回空响应或无效数据，请稍后重试');
    }
    const code = Number(data.err_no);
    const nestedCode = Number(data.data?.error_code ?? 0);
    if (!Number.isFinite(code) || !Number.isFinite(nestedCode)) {
        throw new QishuiResponseError('汽水搜索接口返回了无法识别的数据，请稍后重试');
    }
    if (code || nestedCode) {
        throw new QishuiResponseError(
            `汽水搜索服务暂不可用（错误码 ${code || nestedCode}），请稍后重试`,
            code || nestedCode,
        );
    }
    return data;
}

function mapTrack(track: any): Record<string, any> {
    const base = track?.base_info;
    if (typeof base?.id !== 'string' || !base.id || typeof base.name !== 'string') {
        throw new QishuiResponseError('汽水搜索结果缺少歌曲信息，请稍后重试');
    }
    const artists = Array.isArray(track.related_info?.artist_links)
        ? track.related_info.artist_links
              .filter((artist: any) => typeof artist?.name === 'string')
              .map((artist: any) => ({ id: artist.id, name: artist.name }))
        : [];
    const album = track.related_info?.album_link;
    const durationMs = Number(base.duration_ms ?? 0);
    const duration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs / 1000 : 0;
    // 只保留歌曲目录信息，OpenSDK 返回的 player_info 等播放凭据不进入插件/持久化模型。
    return {
        id: base.id,
        name: base.name,
        artists,
        singer: artists.map((artist: any) => artist.name).join('、'),
        album: { id: album?.id, name: album?.name, url_cover: track.display_info?.cover_url },
        albumName: album?.name ?? '',
        duration,
        interval: `${Math.floor(duration / 60)
            .toString()
            .padStart(2, '0')}:${Math.floor(duration % 60)
            .toString()
            .padStart(2, '0')}`,
    };
}

/** 官方公共目录搜索：匿名客户端令牌仅存于当前 Worker，不借用账号 Cookie 或固定设备凭据。 */
export function createQishuiSearchClient(request: QishuiRequest) {
    const deviceId = (
        (crypto.getRandomValues(new BigUint64Array(1))[0] % 9000000000000000000n) +
        1000000000000000000n
    ).toString();
    const sessions = new Map<string, ISearchSession>();
    let tokenEntry: { task: Promise<string>; expiresAt: number } | undefined;

    function buildUrl(host: string, path: string, extra: Record<string, string> = {}) {
        const params = new URLSearchParams({
            ...COMMON_PARAMS,
            device_id: deviceId,
            did: deviceId,
            iid: deviceId,
            vehicle_id: `qishui-${deviceId}`,
            _timestamp: String(Math.floor(Date.now() / 1000)),
            _nonce: String(crypto.getRandomValues(new Uint16Array(1))[0]),
            ...extra,
        });
        return `https://${host}${API_PREFIX}${path}?${params}`;
    }

    async function call(url: string, body?: any, token?: string) {
        let response: IQishuiHttpResult;
        try {
            response = await request(body === undefined ? 'GET' : 'POST', url, {
                headers: {
                    'User-Agent': USER_AGENT,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                    ...(token ? { 'access-token': token } : {}),
                },
                body,
                timeout: REQUEST_TIMEOUT,
                responseType: 'json',
            });
        } catch (error) {
            if (error instanceof Error && error.message === 'Host request timed out') {
                throw new QishuiResponseError('汽水搜索请求超时，请重试或检查网络设置');
            }
            throw new QishuiResponseError('汽水搜索服务连接失败，请检查网络或稍后重试');
        }
        return checkedResponse(response);
    }

    function getToken() {
        if (tokenEntry && tokenEntry.expiresAt > Date.now()) return tokenEntry;
        const entry = { task: Promise.resolve(''), expiresAt: Infinity };
        entry.task = call(
            buildUrl('open.qishui.com', '/client/token/get/', { trigger_type: 'cold_start' }),
        )
            .then((data) => {
                if (typeof data.client_token !== 'string' || !data.client_token) {
                    throw new QishuiResponseError('汽水搜索客户端初始化失败，请稍后重试');
                }
                const expiresAt = Number(data.expires_time) * 1000 - 30000;
                entry.expiresAt = Math.min(
                    Number.isFinite(expiresAt) && expiresAt > Date.now()
                        ? expiresAt
                        : Date.now() + 300000,
                    Date.now() + 3600000,
                );
                return data.client_token;
            })
            .catch((error) => {
                if (tokenEntry === entry) tokenEntry = undefined;
                throw error;
            });
        tokenEntry = entry;
        return entry;
    }

    async function searchRequest(body: Record<string, any>) {
        let entry = getToken();
        for (let attempt = 0; ; attempt++) {
            const token = await entry.task;
            try {
                return await call(buildUrl('open.douyin.com', '/search/'), body, token);
            } catch (error) {
                if (!(error instanceof QishuiResponseError) || error.code !== 28001008) throw error;
                // 并发请求共用令牌；旧请求的失败不能清掉已换新的令牌，且最多刷新一次。
                if (tokenEntry === entry) tokenEntry = undefined;
                if (attempt) throw error;
                entry = getToken();
            }
        }
    }

    return async (query: string, page: number) => {
        if (!Number.isSafeInteger(page) || page < 1) throw new Error('汽水搜索页码无效');
        let session = sessions.get(query);
        if (page === 1) {
            session = { id: crypto.randomUUID(), cursors: new Map([[1, '0']]) };
            sessions.delete(query);
            sessions.set(query, session);
            if (sessions.size > 20) sessions.delete(sessions.keys().next().value!);
        }
        const cursor = session?.cursors.get(page);
        if (!session || cursor === undefined) {
            throw new Error('汽水搜索分页已失效，请重新搜索');
        }
        const response = await searchRequest({
            q: query,
            cursor,
            search_id: session.id,
            from_search_id: session.id,
            search_method: 'input',
            search_type: 'track',
            search_scene: 'normal',
            scene_name: 'search',
            ab_param: '',
            last_viewed_media: {},
            common_params: {},
        });
        const groups = response.data?.result_groups;
        if (!Array.isArray(groups)) {
            throw new QishuiResponseError('汽水搜索接口缺少结果列表，请稍后重试');
        }
        const group = groups.find((item: any) => item?.id === 'tracks');
        if (!group) return { tracks: [], isEnd: true };
        if (!Array.isArray(group.data)) {
            throw new QishuiResponseError('汽水搜索结果格式异常，请稍后重试');
        }
        const tracks = group.data.map((item: any) => mapTrack(item?.entity?.track));
        const hasMore = group.has_more === true && tracks.length > 0;
        if (hasMore) {
            const nextCursor = group.next_cursor;
            if (
                (typeof nextCursor !== 'string' && typeof nextCursor !== 'number') ||
                String(nextCursor) === '' ||
                String(nextCursor) === cursor
            ) {
                throw new QishuiResponseError('汽水搜索分页数据异常，请重新搜索');
            }
            // OpenSDK 固定返回一批歌曲，下一页必须使用它返回的游标，不能沿用洛雪的 30 条页大小。
            session.cursors.set(page + 1, String(nextCursor));
        }
        return { tracks, isEnd: !hasMore };
    };
}
