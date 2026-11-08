/** 远程主题包仓库镜像 URL 列表（竞速请求取最快响应） */
export const THEME_STORE_BASE_URLS = [
    // raw.githubusercontent.com 在部分网络下直连不可达，优先走 CDN 与镜像
    'https://cdn.jsdelivr.net/gh/raclen/AnhePlayer@master/res/theme-store/prod/',
    'https://gh-proxy.org/https://raw.githubusercontent.com/raclen/AnhePlayer/master/res/theme-store/prod/',
    'https://raw.githubusercontent.com/raclen/AnhePlayer/master/res/theme-store/prod/',
];

/** 主题提交仓库地址 */
export const GITHUB_REPO_URL = 'https://github.com/raclen/AnhePlayer';
