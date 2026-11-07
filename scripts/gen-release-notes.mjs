/**
 * 从 release/version.json 生成 release-notes.md（GitHub Release 发布说明）。
 *
 * changeLog / download 以 version.json 为单一数据源，
 * 与 tauri-build.yml 中的「tag 与公告版本一致性校验」配套使用。
 * 用法：node ./scripts/gen-release-notes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const info = JSON.parse(fs.readFileSync(path.join(root, 'release/version.json'), 'utf-8'));

const lines = [`### AnhePlayer v${info.version}`, '', '**本次更新**'];
for (const item of info.changeLog ?? []) {
    lines.push(`- ${item}`);
}
lines.push('', '**下载**');
lines.push(`- Windows 安装版（推荐）：\`AnhePlayer_${info.version}_x64-setup.exe\``);
lines.push(`- Windows MSI：\`AnhePlayer_${info.version}_x64_en-US.msi\``);

const outPath = path.join(root, 'release-notes.md');
fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
console.log(`[gen-release-notes] wrote ${outPath} for v${info.version}`);

// updater 清单复用同一份变更说明，不混入官网/安装包下载链接。
if (process.env.GITHUB_OUTPUT) {
    const delimiter = `notes_${randomUUID()}`;
    fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `updater_notes<<${delimiter}\n${(info.changeLog ?? []).join('\n')}\n${delimiter}\n`,
        'utf-8',
    );
}
