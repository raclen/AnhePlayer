<div align="center">

<img src="./res/logo.png" width="96" height="96" alt="Anhe Player logo" />

# Anhe Player

A cross-platform, plugin-based, customizable desktop music player.

English | [简体中文](./README.md)

[![License](https://img.shields.io/github/license/raclen/AnhePlayer?style=flat&color=blue)](./LICENSE)
[![Version](https://img.shields.io/github/package-json/v/raclen/AnhePlayer?style=flat&color=orange)](./package.json)
[![Release](https://img.shields.io/github/v/release/raclen/AnhePlayer?style=flat&color=green)](https://github.com/raclen/AnhePlayer/releases)

</div>

## Overview

Anhe Player is an Electron-based desktop music player for Windows, macOS, and Linux. It focuses on local data, plugin-based playback parsing, and UI customization. It does not include ads and does not upload your personal data.

## Download

Download the latest release from [GitHub Releases](https://github.com/raclen/AnhePlayer/releases).

Available packages include:

- Windows installer and portable package
- Windows 7 compatible installer and portable package
- macOS x64 and arm64 DMG packages
- Linux amd64 DEB and RPM packages

## Features

| Feature                       | Description                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Cross-platform desktop app    | Supports Windows, macOS, and Linux                                               |
| Plugin-based playback parsing | Supports LX `.js` plugins for playback URL parsing                               |
| Source redirect               | Routes playback requests to available parser sources                             |
| Multi-quality playback        | Supports low, standard, high, and super quality options when provided by plugins |
| Theme packs                   | Customizes colors, backgrounds, and the overall app appearance                   |
| Local data                    | App data stays on your device and personal data is not uploaded                  |

## Plugins

Anhe Player supports LX `.js` plugin files and http(s) plugin links ending in `.js`.

The built-in plugin is [`changqing_chajian.js`](./changqing_chajian.js) in the repository root. It is loaded on startup as an LX plugin. Sources declared by the plugin are adapted into playback parser sources and can be used for source redirect.

Built-in parser sources:

- `kg音乐`
- `tx音乐`
- `wy音乐`
- `kw音乐`
- `mg音乐`

Plugin capability summary:

```text
Playback parsing    LX musicUrl parsing, multi-quality switching, source redirect
Sources             Kugou, QQ Music, NetEase Cloud Music, Kuwo, Migu
Install             Local .js file, remote .js link
```

## Theme Packs

Anhe Player supports theme packs for UI customization. The app includes light and pure black themes.

A theme pack can be a folder or a `.mftheme` archive:

```text
my-theme/
├── config.json
├── index.css
├── preview.png
└── iframes/
    └── app.html
```

Example `config.json`:

```jsonc
{
    "name": "Theme name",
    "preview": "#000000",
    "description": "Theme description",
    "author": "Author",
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

Use `@/` to reference the theme pack root directory. For the full list of supported theme variables, see the built-in light theme:

[`res/builtin-themes/light/index.css`](./res/builtin-themes/light/index.css)

## Development

### Requirements

| Dependency | Version |
| ---------- | ------- |
| Node.js    | 22      |
| pnpm       | 9       |

### Quick Start

```bash
git clone https://github.com/raclen/AnhePlayer.git
cd AnhePlayer
pnpm install
pnpm start
```

### Commands

| Command            | Description                                        |
| ------------------ | -------------------------------------------------- |
| `pnpm start`       | Start the app                                      |
| `pnpm run dev`     | Start development mode                             |
| `pnpm run package` | Package the app directory for the current platform |
| `pnpm run make`    | Build installers for the current platform          |
| `pnpm run lint`    | Run lint checks                                    |
| `pnpm run format`  | Format code                                        |

## Release

This project uses GitHub Actions to build release packages:

- [`Build`](./.github/workflows/build.yml): builds packages and uploads Actions artifacts
- [`Release`](./.github/workflows/release.yml): downloads artifacts from a selected Build run and creates a GitHub Release

## Contributing

Issues and pull requests are welcome. Please read the [Contributing Guide](./CONTRIBUTING.md) before starting development.

## License

This project is open-sourced under the [AGPL-3.0-only](./LICENSE) license. Please comply with the license when using, modifying, distributing, or republishing this project.
