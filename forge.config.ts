import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'path';

import { mainConfig } from './config/webpack.main.config';
import { rendererConfig } from './config/webpack.renderer.config';
import { preloadConfig } from './config/webpack.preload.config';

const linuxDesktopTemplate = path.resolve(__dirname, 'release/linux-desktop.ejs');
const linuxIcon = {
    '16x16': path.resolve(__dirname, 'release/linux-icons/16x16.png'),
    '24x24': path.resolve(__dirname, 'release/linux-icons/24x24.png'),
    '32x32': path.resolve(__dirname, 'release/linux-icons/32x32.png'),
    '48x48': path.resolve(__dirname, 'release/linux-icons/48x48.png'),
    '64x64': path.resolve(__dirname, 'release/linux-icons/64x64.png'),
    '128x128': path.resolve(__dirname, 'release/linux-icons/128x128.png'),
    '256x256': path.resolve(__dirname, 'release/linux-icons/256x256.png'),
    '512x512': path.resolve(__dirname, 'release/linux-icons/512x512.png'),
    '1024x1024': path.resolve(__dirname, 'release/linux-icons/1024x1024.png'),
} as unknown as string;

const config: ForgeConfig = {
    packagerConfig: {
        asar: true,
        appBundleId: 'cn.anhe.player',
        icon: path.resolve(__dirname, 'res/logo'),
        executableName: 'anhe-player',
        extraResource: [path.resolve(__dirname, 'res')],
        protocols: [
            {
                name: 'AnhePlayer',
                schemes: ['anheplayer'],
            },
        ],
    },
    rebuildConfig: {},
    makers: [
        new MakerDMG({
            format: 'ULFO',
        }),
        new MakerDeb({
            bin: 'anhe-player',
            categories: ['AudioVideo', 'Audio'],
            desktopTemplate: linuxDesktopTemplate,
            icon: linuxIcon,
            mimeType: ['x-scheme-handler/anheplayer'],
        }),
        new MakerRpm({
            bin: 'anhe-player',
            categories: ['AudioVideo', 'Audio'],
            desktopTemplate: linuxDesktopTemplate,
            icon: linuxIcon,
        }),
    ],
    plugins: [
        new AutoUnpackNativesPlugin({}),
        new WebpackPlugin({
            devContentSecurityPolicy:
                "default-src * self blob: data: gap: file:; style-src * self 'unsafe-inline' blob: data: gap: file:; script-src * 'self' 'unsafe-eval' 'unsafe-inline' blob: data: gap: file:; object-src * 'self' blob: data: gap:; img-src * self 'unsafe-inline' blob: data: gap: file:; connect-src self * 'unsafe-inline' blob: data: gap:; frame-src * self blob: data: gap:;",
            mainConfig,
            renderer: {
                config: rendererConfig,
                entryPoints: [
                    {
                        html: './src/documents/index.html',
                        js: './src/renderer/mainWindow/index.tsx',
                        name: 'main_window',
                        preload: {
                            js: './src/preload/main.ts',
                            config: preloadConfig,
                        },
                    },
                    {
                        html: './src/documents/index.html',
                        js: './src/renderer/lyricWindow/index.tsx',
                        name: 'lyric_window',
                        preload: {
                            js: './src/preload/auxiliary.ts',
                            config: preloadConfig,
                        },
                    },
                    {
                        html: './src/documents/index.html',
                        js: './src/renderer/minimodeWindow/index.tsx',
                        name: 'minimode_window',
                        preload: {
                            js: './src/preload/auxiliary.ts',
                            config: preloadConfig,
                        },
                    },
                ],
            },
        }),
        // Externals plugin must be after WebpackPlugin so that
        // packagerConfig.ignore is already set as a function
        {
            name: '@timfish/forge-externals-plugin',
            config: {
                externals: ['better-sqlite3'],
                includeDeps: true,
            },
        },
        // Fuses are used to enable/disable various Electron functionality
        // at package time, before code signing the application
        new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: false,
        }),
    ],
};

export default config;
