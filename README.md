<div align="center">

<img src="./res/logo.svg" width="96" height="96" alt="AnhePlayer Logo" />

# AnhePlayer

一款专为 Windows 打造的现代化、高颜值、支持洛雪音源插件的轻量音乐播放器。

[English](./README_EN.md) | 简体中文

[![License](https://img.shields.io/github/license/raclen/AnhePlayer?style=flat&color=blue)](./LICENSE)
[![Version](https://img.shields.io/github/package-json/v/raclen/AnhePlayer?style=flat&color=orange)](./package.json)
[![Release](https://img.shields.io/github/v/release/raclen/AnhePlayer?style=flat&color=green)](https://github.com/raclen/AnhePlayer/releases)
[![Downloads](https://img.shields.io/github/downloads/raclen/AnhePlayer/total?style=flat&color=brightgreen)](https://github.com/raclen/AnhePlayer/releases)
[![Stars](https://img.shields.io/github/stars/raclen/AnhePlayer?style=flat&color=yellow)](https://github.com/raclen/AnhePlayer/stargazers)

</div>

## 简介

AnhePlayer 是一款专为 Windows 设计的现代化桌面音乐播放器，基于 **Tauri v2** 轻量级原生引擎打造。它专注于本地数据管理、外部插件音源解析和界面定制，不内置广告，也不会上传你的个人数据。

桌面端采用单一 **Tauri v2 + Rust** 运行链路，洛雪音源插件在 Web Worker 沙箱中运行。

应用内网络请求**默认直连**，不跟随 Windows 系统代理或 HTTP(S) 代理环境变量。如需走代理，可在「设置 → 网络」中手动填写 HTTP 或 SOCKS5 代理服务器，并重启应用让网页请求生效。此规则覆盖音源、播放与下载、网页资源、网易登录、WebDAV 和应用更新；播放器内部用于音频播放的本地转发服务仍保留，不会修改系统代理配置。外部浏览器及 VPN/TUN 等系统级网络路由不在此规则控制范围内。

<img width="1022" height="692" alt="image" src="https://img.meituan.net/content/1a7c6bc9cfc1c3f7dfa9a95d2a194cf0337799.png" />

## 下载

请前往 [GitHub Releases](https://github.com/raclen/AnhePlayer/releases) 下载最新版本。

当前仅支持 **Windows (10 / 11)** 系统：

- **Windows 安装包** (`.msi` / `.exe`)
- **Windows 便携免安装版** (解压即用)

## 功能模块

| 模块           | 支持能力                                                                 |
| -------------- | ------------------------------------------------------------------------ |
| Windows 桌面端 | 专为 Windows 深度优化，秒级启动与极低内存占用，提供安装包与便携版        |
| 播放与队列     | 支持播放队列、下一首播放、顺序/随机/单曲循环、倍速播放和音频输出设备选择 |
| 在线音乐       | 通过插件提供歌曲、歌手、专辑、歌单、排行榜和热门歌单等内容浏览与搜索     |
| 歌单管理       | 支持创建、重命名、删除、收藏、歌单内搜索，以及单曲/歌单链接导入          |
| 本地音乐       | 支持扫描本地文件夹，并按单曲、歌手、专辑、文件夹管理本地曲库             |
| 插件系统       | 支持本地插件与远程插件链接，插件能力决定可用音源和解析范围               |
| 播放解析       | 支持多音质切换、音质缺失策略、播放失败后换源重试/跳过/暂停等处理方式     |
| 歌词           | 支持歌词搜索与关联、翻译歌词、进度偏移、歌词保存/下载和桌面歌词          |
| 下载管理       | 支持设置下载目录、默认音质、并发数量和文件命名格式                       |
| 主题外观       | 支持内置主题、本地主题包和远程主题包，自定义颜色、背景与界面观感         |
| 备份与迁移     | 支持文件备份、WebDAV 备份恢复，以及旧版数据导入                          |
| 隐私与本地数据 | 应用数据默认保存在本机，不会上传个人数据                                 |

## 插件

AnhePlayer 默认不内置音源解析插件。你可以在插件管理中安装洛雪 `.js` 插件文件，或添加以 `.js` 结尾的 http(s) 插件链接。

插件声明的 source 会被适配为播放器中的播放解析源，可用于播放解析、多音质切换和音源重定向。

插件能力范围：

```text
播放解析    洛雪 musicUrl 解析、多音质切换、音源重定向
安装方式    本地 .js 文件、远程 .js 链接
```

## 主题包

AnhePlayer 支持通过主题包自定义界面外观。本地内置主题包括浅色主题和纯黑主题，主题市场里还提供了多套可直接安装的策展主题。

主题包可以是一个文件夹，也可以是 `.mftheme` 压缩包：

```text
my-theme/
├── config.json
├── index.css
├── preview.png
└── iframes/
    └── app.html
```

`config.json` 示例：

```jsonc
{
    "name": "主题名称",
    "preview": "#000000",
    "description": "主题描述",
    "author": "作者",
    "authorUrl": "https://example.com",
    "version": "1.0.0",
    "srcUrl": "https://example.com/theme.mftheme",
    "thumb": "@/thumb.png",
    "blurHash": "LEHV6nWB2yk8pyo...",
    "iframe": {
        "app": "@/iframes/app.html",
    },
}
```

路径中的 `@/` 表示主题包根目录。完整主题变量可参考内置浅色主题：

[`res/builtin-themes/light/index.css`](./res/builtin-themes/light/index.css)

主题市场当前提供的策展主题包括：

- `柔雾白昼`：Figma 风格浅色主题
- `极夜流光`：Figma 风格深色主题
- `Silk Motion`：更偏 Apple Music 风
- `Pulse Grid`：更偏 Linear / Raycast 风
- `Hype Wave`：更偏潮流音乐产品风

## 开发

### 环境要求

| 依赖    | 版本  | 说明                                        |
| ------- | ----- | ------------------------------------------- |
| Node.js | 22    | 前端与构建环境                              |
| pnpm    | 9+    | 包管理器                                    |
| Rust    | 1.80+ | Tauri v2 核心编译 (可选，仅用于 Tauri 运行) |

> 详细的 Tauri v2 架构设计与迁移细节请参考 [Tauri 迁移与开发指南](./TAURI_MIGRATION_GUIDE.md)。

### 快速开始

```bash
git clone https://github.com/raclen/AnhePlayer.git
cd AnhePlayer
pnpm install

# 启动 Tauri v2 开发环境
pnpm tauri:dev
```

### 常用命令

| 命令               | 说明                                     |
| ------------------ | ---------------------------------------- |
| `pnpm tauri:dev`   | **Tauri v2 开发模式** (Vite + Rust 核心) |
| `pnpm tauri:build` | **构建 Tauri v2 超轻量安装包** (MSI/EXE) |
| `pnpm run lint`    | 代码检查                                 |
| `pnpm run format`  | 格式化代码                               |

## 发布

项目通过 GitHub Actions 构建 Windows 桌面安装包：

- [`Tauri Build & Release`](./.github/workflows/tauri-build.yml)：自动构建 Windows (x86_64) 安装包并发布到 Releases

## 贡献

欢迎提交 Issue 和 Pull Request。开发前请先阅读 [贡献指南](./CONTRIBUTING.md)。

## Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=raclen/AnhePlayer&type=Date)](https://star-history.com/#raclen/AnhePlayer&Date)

## 许可证

本项目基于 [AGPL-3.0-only](./LICENSE) 协议开源。请在使用、修改、分发或二次发布时遵守许可证要求。
