import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const info = JSON.parse(fs.readFileSync(path.join(root, 'release/version.json'), 'utf8'));
const bundle = path.join(root, 'src-tauri/target/release/bundle');
const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const publicKeyText = Buffer.from(config.plugins.updater.pubkey, 'base64').toString('utf8');
const publicKey = Buffer.from(publicKeyText.split(/\r?\n/)[1] ?? '', 'base64');
assert.equal(publicKey.length, 42, '更新公钥格式不正确');
assert.equal(config.version, info.version);
assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    info.version,
);
const assets = new Map();
for (const [folder, extension] of [
    ['nsis', '.exe'],
    ['msi', '.msi'],
]) {
    const directory = path.join(bundle, folder);
    const installers = fs.readdirSync(directory).filter((name) => name.endsWith(extension));
    assert.ok(installers.length, `缺少 ${folder} 安装包`);
    for (const name of installers) {
        const signature = fs.readFileSync(path.join(directory, `${name}.sig`), 'utf8').trim();
        assert.ok(signature, `${name} 缺少更新签名`);
        const lines = Buffer.from(signature, 'base64').toString('utf8').split(/\r?\n/);
        const signedData = Buffer.from(lines[1] ?? '', 'base64');
        assert.equal(signedData.length, 74, `${name} 的签名格式不正确`);
        // Tauri CLI 对密钥不匹配仅发警告，发布时必须将其升级为失败。
        assert.ok(
            signedData.subarray(2, 10).equals(publicKey.subarray(2, 10)),
            `${name} 使用了不匹配的签名密钥`,
        );
        assert.ok(lines[2]?.endsWith(`\tversion:${info.version}`), `${name} 的签名未绑定当前版本`);
        assets.set(name, signature);
    }
}

// dispatch 不发布清单；标签构建必须在公开 Release 前验证清单与本轮产物一致。
if (process.env.GITHUB_REF?.startsWith('refs/tags/v')) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'latest.json'), 'utf8'));
    assert.equal(manifest.version, info.version);
    assert.equal(manifest.notes, info.changeLog.join('\n'));
    for (const target of ['windows-x86_64', 'windows-x86_64-nsis', 'windows-x86_64-msi']) {
        const entry = manifest.platforms[target];
        assert.ok(entry, `缺少 ${target} 更新项`);
        const url = new URL(entry.url);
        assert.equal(url.origin, 'https://github.com');
        assert.ok(
            url.pathname.startsWith(`/raclen/AnhePlayer/releases/download/v${info.version}/`),
        );
        const name = decodeURIComponent(url.pathname.split('/').at(-1));
        assert.ok(assets.has(name), `${target} 引用了本轮构建以外的安装包`);
        assert.equal(entry.signature.trim(), assets.get(name));
        assert.ok(name.endsWith(target.endsWith('-msi') ? '.msi' : '.exe'));
    }
}
console.log('更新安装包、签名文件与发布清单一致性校验通过');
