<div align="center">

# 🎵 安禾播放器

**A customizable, ad-free music player with built-in LX Music source parsing**

[![GitHub Stars](https://img.shields.io/github/stars/maotoumao/AnhePlayerDesktop?style=flat&logo=github&color=yellow)](https://github.com/maotoumao/AnhePlayerDesktop/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/maotoumao/AnhePlayerDesktop?style=flat&logo=github)](https://github.com/maotoumao/AnhePlayerDesktop/network/members)
[![GitCode Stars](https://gitcode.com/maotoumao/AnhePlayerDesktop/star/badge.svg)](https://gitcode.com/maotoumao/AnhePlayerDesktop)
[![License](https://img.shields.io/github/license/maotoumao/AnhePlayerDesktop?style=flat&color=blue)](./LICENSE)
[![Downloads](https://img.shields.io/github/downloads/maotoumao/AnhePlayerDesktop/total?style=flat&color=green)](https://github.com/maotoumao/AnhePlayerDesktop/releases)
[![Issues](https://img.shields.io/github/issues/maotoumao/AnhePlayerDesktop?style=flat)](https://github.com/maotoumao/AnhePlayerDesktop/issues)
[![Version](https://img.shields.io/github/package-json/v/maotoumao/AnhePlayerDesktop?style=flat&color=orange)](./package.json)

<a href="https://trendshift.io/repositories/3961" target="_blank"><img src="https://trendshift.io/api/badge/repositories/3961" alt="maotoumao%2FAnhePlayerDesktop | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>

English | **[简体中文](./README.md)**

</div>

---

> [!IMPORTANT]
> **Usage Agreement**
>
> This project is open-sourced under the [AGPL 3.0](./LICENSE) license. Please comply with the license when using this project. Additionally, please be aware of the following:
>
> 1. When packaging or redistributing, **please credit the source**: https://github.com/maotoumao/MusicFree
> 2. Do not use for commercial purposes; use the code legally and compliantly
> 3. If the license changes, it will be updated in this GitHub repository without separate notice

---

## ✨ Introduction

A plugin-based, customizable, ad-free music player for **Windows**, **macOS**, and **Linux**.

### 📥 Download

👉 [Feishu Cloud Drive](https://r0rvr854dd1.feishu.cn/drive/folder/IrVEfD67KlWZGkdqwjecLHFNnBb?from=from_copylink)

---

## 🚀 Features

|       Feature       | Description                                                                                                                                                                                                                                                       |
| :-----------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **🔌 LX Music source** | Bundles the `changqing_chajian.js` LX Music plugin for playback URL parsing across Kugou, QQ Music, NetEase Cloud Music, Kuwo, and Migu. Playback can be routed through these sources with source redirect. |
| **🎨 Customizable** | Customize the app's appearance and background via theme packs, with a brand-new semantic CSS variable system and iframe backgrounds. See [Theme Packs](#-theme-packs) below.                                                                                      |
|   **🚫 Ad-free**    | Open-sourced under AGPL 3.0, and will remain free.                                                                                                                                                                                                                |
|   **🔒 Privacy**    | All data is stored locally. Your personal information is never uploaded.                                                                                                                                                                                          |

**Current plugin capabilities**: the built-in LX Music plugin handles playback URL parsing and multi-quality switching (low / standard / high / super). Search, playlists, lyrics, and other content features continue to come from the app's existing capabilities or other available plugins.

---

## 🔌 Plugins

This branch uses LX Music plugins for playback parsing and no longer runs the old MusicFree-specific plugin execution path. The root-level `changqing_chajian.js` file is loaded as a built-in LX Music plugin on startup, and each declared source appears as a playback parser that can be selected for source redirect.

### Built-In LX Sources

- `kg音乐`
- `tx音乐`
- `wy音乐`
- `kw音乐`
- `mg音乐`

The install dialog now accepts LX Music `.js` plugin files or http(s) links ending with `.js`.

### Plugin Capabilities

```
Play   ─── LX musicUrl parsing · Multi-quality switching · Source redirect
Sources ─ Kugou / QQ Music / NetEase Cloud Music / Kuwo / Migu
Install ─ Local .js · Remote .js
```

### Plugin Sandbox

LX Music plugins run in a secure sandbox through `globalThis.lx`: they register `request` handlers and declare available sources through the `inited` event. The app adapts each source into a `getMediaSource` playback parser.

---

## 🎨 Theme Packs

安禾播放器 supports full UI customization through theme packs. Two themes are built in: **Light** and **Pure Black (AMOLED)**.

### Theme Pack Structure

A theme pack is a folder (or `.mftheme` archive) containing the following files:

```
my-theme/
├── config.json      # Theme configuration (required)
├── index.css        # Style definitions (required)
├── preview.png      # Preview image (optional)
└── iframes/         # iframe backgrounds (optional)
    └── app.html
```

### config.json

```jsonc
{
    "name": "Theme Name", // Required
    "preview": "#000000", // Preview color or image path
    "description": "Theme description",
    "author": "Author",
    "authorUrl": "https://...",
    "version": "1.0.0",
    "srcUrl": "https://...", // Remote update URL
    "thumb": "@/thumb.png", // Thumbnail
    "blurHash": "LEHV6nWB2yk8pyo...", // Loading placeholder (BlurHash)
    "iframe": {
        "app": "@/iframes/app.html", // Full app background
    },
}
```

> Use `@/` in paths to reference the theme pack root directory.

### index.css — Semantic CSS Variable System

The new version adopts a **semantic CSS variable** design, organized into six categories by visual purpose. Override these variables in `index.css` to define your theme:

|    Category    |       Prefix       | Purpose                            | Examples                                           |
| :------------: | :----------------: | ---------------------------------- | -------------------------------------------------- |
| **Background** |   `--color-bg-*`   | Page, sidebar, modal backgrounds   | `--color-bg-base`, `--color-bg-sidebar`            |
|    **Fill**    |  `--color-fill-*`  | Buttons, interactive element fills | `--color-fill-brand`, `--color-fill-neutral-hover` |
|    **Text**    |  `--color-text-*`  | Text colors at various levels      | `--color-text-primary`, `--color-text-secondary`   |
|   **Border**   | `--color-border-*` | Dividers, borders                  | `--color-border-default`, `--color-border-subtle`  |
|   **Status**   | `--color-status-*` | Info / Warning / Danger / Success  | `--color-status-danger-text`                       |
|   **Shadow**   |    `--shadow-*`    | Elevation shadows                  | `--shadow-sm`, `--shadow-lg`                       |

> For the full list of variables, refer to the built-in theme [`res/builtin-themes/light/index.css`](./res/builtin-themes/light/index.css).

### iframe Backgrounds

Use the `iframe.app` field in `config.json` to set any HTML page as the app background, enabling particle effects, animations, and other visuals that pure CSS cannot achieve. Both local HTML files and remote URLs are supported.

### Theme Pack Examples

Example repository: https://github.com/maotoumao/MusicFreeThemePacks

---

## 🛠️ Getting Started

### Prerequisites

| Dependency | Version |
| :--------: | :-----: |
|  Node.js   |  >= 18  |
|    pnpm    | latest  |

### Quick Start

```bash
# Clone the repository
git clone https://github.com/maotoumao/AnhePlayerDesktop.git
cd AnhePlayerDesktop

# Install dependencies
pnpm install

# Start the app
pnpm start

# Development mode (with Electron DevTools)
pnpm run dev
```

### Available Commands

|      Command      | Description      |
| :---------------: | ---------------- |
|   `pnpm start`    | Launch the app   |
|  `pnpm run dev`   | Development mode |
|  `pnpm run make`  | Build installers |
|  `pnpm run lint`  | Run linter       |
| `pnpm run format` | Format code      |

---

## 🤝 Contributing

Contributions are welcome! Please read the [Contributing Guide](./CONTRIBUTING.md) for development guidelines and submission process.

---

## � Support This Project

If you enjoy this project or would like to see it maintained, you can support it by:

1. ⭐ Starring this repo and sharing it with others
2. Following the WeChat channel【一只猫头猫】for updates

<img src="./src/assets/imgs/wechat_channel.jpg" height="160px" title="WeChat Channel" />

---

## 📸 Screenshots

#### Home

![Home](./.imgs/screenshot-home.png)

#### Search

![Search](./.imgs/screenshot-search.png)

#### Plugin Manager

![Plugin Manager](./.imgs/screenshot-plugin.png)

#### Themes

![Themes](./.imgs/screenshot-theme.png)

#### Settings

![Settings](./.imgs/screenshot-settings.png)

#### Mini Mode

<div align="center">

![Mini Mode](./.imgs/screenshot-minimode.png)

</div>
