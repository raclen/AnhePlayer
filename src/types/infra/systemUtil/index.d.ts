/** 版本更新信息 */
export interface IUpdateInfo {
    /** 当前应用版本号 */
    version: string;
    /** 仅已正式发布且存在匹配平台安装包的版本视为可用更新 */
    update?: {
        version: string;
        changeLog?: string[];
        /** 安装包已在本次进程中下载并通过签名校验 */
        ready?: boolean;
    };
}

/** 下载进度；校验成功以 downloadUpdate 的 Promise 完成为准。 */
export interface IUpdateProgress {
    version: string;
    stage: 'downloading' | 'verifying';
    downloadedBytes: number;
    totalBytes?: number | null;
    /** 0 表示官方源，其他值表示备用源序号 */
    attempt: number;
}
