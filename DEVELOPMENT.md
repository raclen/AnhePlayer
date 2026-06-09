# 安禾播放器 项目分析与开发指南

## 项目概述

安禾播放器 是一个基于 Electron 的插件化音乐播放器桌面应用。该项目使用 TypeScript 开发，前端采用 React 框架，通过 Webpack 进行打包构建。

## 项目结构分析

### 根目录文件

- `package.json`: 项目配置，包含依赖、脚本和 Electron Forge 配置
- `tsconfig.json`: TypeScript 配置
- `eslint.config.mjs`: ESLint 配置
- `forge.config.ts`: Electron Forge 打包配置
- `README.md`: 项目说明文档
- `changelog.md`: 更新日志

### 主要目录结构

- `src/`: 源代码目录
    - `main/`: Electron 主进程代码
        - `index.ts`: 主进程入口
        - `core/`: 核心功能模块
            - `appConfig/`: 应用配置管理
            - `appSync/`: 应用同步功能
            - `backup/`: 备份恢复功能
            - `database/`: 数据库操作
            - `downloadManager/`: 下载管理器
            - `fsUtil/`: 文件系统工具
            - `globalContext/`: 全局上下文
            - `i18n/`: 国际化支持
            - `localMusic/`: 本地音乐管理
            - `logger/`: 日志系统
            - `mediaMeta/`: 媒体元数据处理
            - `musicSheet/`: 音乐歌单管理
            - `pluginManager/`: 插件管理
            - `requestForwarder/`: 请求转发器
            - `shortCut/`: 快捷键管理
            - `systemUtil/`: 系统工具
            - `themepack/`: 主题包管理
            - `windowDrag/`: 窗口拖拽功能
    - `renderer/`: 渲染进程代码（React 应用）
        - `bootstrap/`: 应用启动引导
            - `auxiliaryWindow.ts`: 辅助窗口初始化
            - `global.scss`: 全局样式
            - `mainWindow.ts`: 主窗口初始化
            - `postBootstrap.ts`: 启动后处理
        - `common/`: 共享组件和工具
            - `hooks/`: React 自定义钩子
            - `icons/`: 图标组件
            - `kvStore.ts`: 键值存储
            - `repeatModeMap.ts`: 重复模式映射
        - `lyricWindow/`: 歌词窗口
            - `App/`: 歌词应用组件
            - `components/`: 歌词相关组件
            - `index.tsx`: 歌词窗口入口
        - `mainWindow/`: 主窗口应用
            - `App.tsx`: 主应用组件
            - `App.scss`: 主应用样式
            - `common/`: 主窗口共享工具
            - `components/`: React 组件库
                - `business/`: 业务逻辑组件（如播放器、歌单等）
                - `layout/`: 布局组件（如侧边栏、头部等）
                - `ui/`: 基础UI组件（如按钮、输入框等）
            - `core/`: 核心功能模块
                - `commandHandlers.ts`: 命令处理器
                - `legacyMigration.ts`: 遗留数据迁移
                - `recentlyPlayed.ts`: 最近播放管理
                - `trackPlayer/`: 音轨播放器
            - `hooks/`: 主窗口自定义钩子
            - `index.tsx`: 主窗口入口
            - `pages/`: 页面组件
                - `AlbumPage/`: 专辑页面
                - `ArtistPage/`: 艺术家页面
                - `ComponentShowcasePage/`: 组件展示页面
                - `DownloadPage/`: 下载页面
                - `LocalMusicPage/`: 本地音乐页面
                - `LocalSheetPage/`: 本地歌单页面
                - `NotFoundPage/`: 404页面
                - `PluginManagerPage/`: 插件管理页面
                - `RecentlyPlayedPage/`: 最近播放页面
                - `RecommendSheetsPage/`: 推荐歌单页面
                - `SearchPage/`: 搜索页面
                - `SettingPage/`: 设置页面
                - `SheetPage/`: 歌单页面
                - `ThemePage/`: 主题页面
                - `ToplistDetailPage/`: 排行榜详情页面
                - `ToplistPage/`: 排行榜页面
            - `router.tsx`: 路由配置
            - `routes.ts`: 路由定义
        - `minimodeWindow/`: 迷你模式窗口
            - `App/`: 迷你模式应用组件
            - `index.tsx`: 迷你模式窗口入口
    - `preload/`: 预加载脚本
        - `auxiliary.ts`: 辅助预加载
        - `main.ts`: 主预加载脚本
    - `types/`: TypeScript 类型定义
        - `assets.d.ts`: 资源类型
        - `global.d.ts`: 全局类型
        - `media.d.ts`: 媒体类型
        - `plugin.d.ts`: 插件类型
        - `infra/`: 基础设施类型
        - `main/`: 主进程类型
- `config/`: Webpack 配置
    - `webpack.main.config.ts`: 主进程打包配置
    - `webpack.plugins.ts`: 插件配置
    - `webpack.preload.config.ts`: 预加载打包配置
    - `webpack.renderer.config.ts`: 渲染进程打包配置
    - `webpack.rules.ts`: Webpack 规则配置
- `res/`: 资源文件
    - `builtin-themes/`: 内置主题
        - `light/`: 浅色主题
        - `pure-black/`: 纯黑主题
    - `lang/`: 语言包（en-US.json, zh-CN.json, zh-TW.json）
- `release/`: 发布相关
    - `build-windows.iss`: Windows 安装包脚本
    - `version.json`: 版本信息

## 开发调试方法

### 环境准备

1. 安装 Node.js 22.x（必须使用 22.x；可通过 `.nvmrc` 切换到已验证的 22.22.3）
2. 安装 pnpm: `npm install -g pnpm`
3. 克隆项目并进入目录
4. 安装依赖: `pnpm install`

如果使用 fnm/nvm，进入项目后先运行 `fnm use` 或 `nvm use`。不要使用 Node 24 打包：当前 Electron Forge / Electron Packager 组合在 Node 24 下可能提前结束且不生成 `out/` 目录。

### 开发模式运行

```bash
pnpm run dev
```

此命令会：

- 设置控制台编码为 UTF-8 (chcp 65001)
- 启动 Electron 应用
- 启用 Electron 调试模式 (--inspect-electron)

### 代码检查和格式化

- 代码检查: `pnpm run lint`
- 自动修复: `pnpm run lint:fix`
- 格式化: `pnpm run format`
- 格式检查: `pnpm run format:check`

### 调试技巧

- 使用 Chrome DevTools 调试渲染进程
- 使用 VS Code 的 Electron 调试配置调试主进程
- 查看 `src/shared/logger/` 的日志输出

## 打包成 exe 方法

### Windows exe 打包

当前配置主要针对 macOS 和 Linux。要打包 Windows exe，需要添加 Windows maker。

1. 安装 Windows maker:

```bash
pnpm add -D @electron-forge/maker-squirrel
```

2. 更新 `forge.config.ts`，添加 Windows maker:

```typescript
import { MakerSquirrel } from '@electron-forge/maker-squirrel';

// 在 makers 数组中添加:
new MakerSquirrel({
    name: '安禾播放器',
    exe: 'AnhePlayer.exe',
    setupExe: 'AnhePlayerSetup.exe',
    setupIcon: path.resolve(__dirname, 'res/logo.ico'),
}),
```

3. 打包命令:

```bash
pnpm run make
```

此命令会在 `out/` 目录生成 Windows 安装包。

### 其他打包选项

- `pnpm run package`: 只打包应用（不生成安装包）
- `pnpm run publish`: 发布到配置的发布渠道

### 注意事项

- 确保有合适的图标文件 (res/logo.ico for Windows)
- 打包必须使用 Node.js 22.x；Node 24 下可能出现命令返回成功但没有产物的情况
- 打包前确保所有依赖正确安装
- 对于生产构建，使用 `NODE_ENV=production`

## 构建流程

1. 开发阶段: `pnpm run dev`
2. 代码检查: `pnpm run lint && pnpm run format:check`
3. 打包测试: `pnpm run package`
4. 最终发布: `pnpm run make`

## 插件系统

该应用支持插件化扩展，插件管理代码位于 `src/shared/plugin-manager/`。

## 国际化

支持多语言，语言包位于 `res/lang/`，国际化代码在 `src/shared/i18n/`。
