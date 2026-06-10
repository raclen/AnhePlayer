<div align="center">

<img src="./res/logo.svg" width="96" height="96" alt="安禾播放器 Logo" />

# 安禾播放器

一款跨平台、可定制、支持插件扩展的桌面音乐播放器。

[English](./README_EN.md) | 简体中文

[![License](https://img.shields.io/github/license/raclen/AnhePlayer?style=flat&color=blue)](./LICENSE)
[![Version](https://img.shields.io/github/package-json/v/raclen/AnhePlayer?style=flat&color=orange)](./package.json)
[![Release](https://img.shields.io/github/v/release/raclen/AnhePlayer?style=flat&color=green)](https://github.com/raclen/AnhePlayer/releases)

</div>

## 简介

安禾播放器是一个基于 Electron 的桌面音乐播放器，支持 Windows、macOS 和 Linux。它专注于本地数据管理、外部插件音源解析和界面定制，不内置广告，也不会上传你的个人数据。
<img width="1162" height="860" alt="image" src="https://github.com/user-attachments/assets/f2f6a069-229e-414a-9223-f4f9a9ad4ffc" />


## 下载

请前往 [GitHub Releases](https://github.com/raclen/AnhePlayer/releases) 下载最新版本。

当前发布包包含：

- Windows 安装版与便携版
- Windows 7 兼容版安装包与便携版
- macOS x64 与 arm64 DMG
- Linux amd64 DEB 与 RPM

## 功能模块

| 模块           | 支持能力                                                                 |
| -------------- | ------------------------------------------------------------------------ |
| 跨平台桌面端   | 支持 Windows、macOS 和 Linux，提供安装包与便携版                         |
| 播放与队列     | 支持播放队列、下一首播放、顺序/随机/单曲循环、倍速播放和音频输出设备选择 |
| 在线音乐       | 通过插件提供歌曲、歌手、专辑、歌单、排行榜和热门歌单等内容浏览与搜索     |
| 歌单管理       | 支持创建、重命名、删除、收藏、歌单内搜索，以及单曲/歌单链接导入          |
| 本地音乐       | 支持扫描本地文件夹，并按单曲、歌手、专辑、文件夹管理本地曲库             |
| 插件系统       | 支持本地插件、远程插件链接与订阅更新，插件能力决定可用音源和解析范围     |
| 播放解析       | 支持多音质切换、音质缺失策略、播放失败后换源重试/跳过/暂停等处理方式     |
| 歌词           | 支持歌词搜索与关联、翻译歌词、进度偏移、歌词保存/下载和桌面歌词          |
| 下载管理       | 支持设置下载目录、默认音质、并发数量和文件命名格式                       |
| 主题外观       | 支持内置主题、本地主题包和远程主题包，自定义颜色、背景与界面观感         |
| 备份与迁移     | 支持文件备份、WebDAV 备份恢复，以及旧版数据导入                          |
| 隐私与本地数据 | 应用数据默认保存在本机，不会上传个人数据                                 |

## 插件

安禾播放器默认不内置音源解析插件。你可以在插件管理中安装洛雪 `.js` 插件文件，或添加以 `.js` 结尾的 http(s) 插件链接。

插件声明的 source 会被适配为播放器中的播放解析源，可用于播放解析、多音质切换和音源重定向。

插件能力范围：

```text
播放解析    洛雪 musicUrl 解析、多音质切换、音源重定向
安装方式    本地 .js 文件、远程 .js 链接
```

## 主题包

安禾播放器支持通过主题包自定义界面外观。内置主题包括浅色主题和纯黑主题。

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

## 开发

### 环境要求

| 依赖    | 版本 |
| ------- | ---- |
| Node.js | 22   |
| pnpm    | 9    |

### 快速开始

```bash
git clone https://github.com/raclen/AnhePlayer.git
cd AnhePlayer
pnpm install
pnpm start
```

### 常用命令

| 命令               | 说明                 |
| ------------------ | -------------------- |
| `pnpm start`       | 启动应用             |
| `pnpm run dev`     | 开发模式             |
| `pnpm run package` | 打包当前平台应用目录 |
| `pnpm run make`    | 构建当前平台安装包   |
| `pnpm run lint`    | 代码检查             |
| `pnpm run format`  | 格式化代码           |

## 发布

项目使用 GitHub Actions 构建多平台发布包：

- [`Build`](./.github/workflows/build.yml)：构建并上传 Actions artifacts
- [`Release`](./.github/workflows/release.yml)：从指定 Build run 下载 artifacts，并创建 GitHub Release

## 贡献

欢迎提交 Issue 和 Pull Request。开发前请先阅读 [贡献指南](./CONTRIBUTING.md)。

## 许可证

本项目基于 [AGPL-3.0-only](./LICENSE) 协议开源。请在使用、修改、分发或二次发布时遵守许可证要求。
