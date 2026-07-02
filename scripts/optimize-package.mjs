#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const keepLocales = new Set(
    (process.env.ANHE_KEEP_LOCALES || 'en-US,zh-CN')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => (item.endsWith('.pak') ? item : `${item}.pak`)),
);

const junkDirectoryNames = new Set([
    '.cache',
    '.github',
    '.vscode',
    'benchmark',
    'benchmarks',
    'coverage',
    'doc',
    'docs',
    'example',
    'examples',
    'test',
    'tests',
    '__tests__',
]);

const junkFileNames = new Set([
    '.DS_Store',
    'CHANGELOG',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'HISTORY.md',
    'README',
    'README.md',
    'SECURITY.md',
]);

const junkFileExtensions = new Set(['.map', '.tsbuildinfo']);

let removedBytes = 0;
let removedCount = 0;

function pathSize(targetPath) {
    if (!fs.existsSync(targetPath)) return 0;
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;

    let total = 0;
    for (const entry of fs.readdirSync(targetPath)) {
        total += pathSize(path.join(targetPath, entry));
    }
    return total;
}

function removePath(targetPath) {
    if (!fs.existsSync(targetPath)) return;
    removedBytes += pathSize(targetPath);
    removedCount += 1;
    fs.rmSync(targetPath, { recursive: true, force: true });
}

function pruneLocales(packageDir) {
    const localesDir = path.join(packageDir, 'locales');
    if (!fs.existsSync(localesDir)) return;

    for (const entry of fs.readdirSync(localesDir)) {
        if (entry.endsWith('.pak') && !keepLocales.has(entry)) {
            removePath(path.join(localesDir, entry));
        }
    }
}

function pruneJunk(root) {
    if (!fs.existsSync(root)) return;

    for (const entry of fs.readdirSync(root)) {
        const fullPath = path.join(root, entry);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            if (junkDirectoryNames.has(entry)) {
                removePath(fullPath);
            } else {
                pruneJunk(fullPath);
            }
            continue;
        }

        if (junkFileNames.has(entry) || junkFileExtensions.has(path.extname(entry))) {
            removePath(fullPath);
        }
    }
}

function optimizePackage(packageDir) {
    const resolved = path.resolve(packageDir);
    if (!fs.existsSync(resolved)) {
        console.warn(`[package-optimize] skip missing path: ${resolved}`);
        return;
    }

    pruneLocales(resolved);
    pruneJunk(path.join(resolved, 'resources', 'app.asar.unpacked'));
    pruneJunk(path.join(resolved, 'resources', 'app', 'node_modules'));
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
    console.error('Usage: node scripts/optimize-package.mjs <package-dir> [...package-dir]');
    process.exit(1);
}

for (const target of targets) {
    optimizePackage(target);
}

console.log(
    `[package-optimize] removed ${removedCount} entries, saved ${(removedBytes / 1024 / 1024).toFixed(2)} MB`,
);
