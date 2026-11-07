---
name: project-release-publisher
description: Run the current AnhePlayer Tauri release workflow end to end. Use whenever the user asks to bump the version, build installers, create a release, push a release tag, rerun packaging, or repair missing v* release assets.
---

# AnhePlayer Release Publisher

Use this skill to publish AnhePlayer through the repository's current Tauri workflow. Always inspect the workflow and version sources before acting; do not rely on an older Electron or split Build/Release process.

## Current Release Architecture

There is one workflow:

- `.github/workflows/tauri-build.yml`

It has two trigger modes with different semantics:

- Push a `v*` tag: build Windows packages, upload the Actions artifact, generate release notes, and publish the GitHub Release.
- `workflow_dispatch`: validation build only. It uploads the Actions artifact but must not create a tag or GitHub Release.

Do not look for or invoke `build.yml` / `release.yml`; those workflows no longer exist.

The normal release path is:

1. Inspect the worktree and remote state.
2. Choose the next unused version.
3. Synchronize all version sources and the user-facing changelog.
4. Run local checks.
5. Commit and push `master`.
6. Create and push an annotated `v<VERSION>` tag.
7. Watch `tauri-build.yml` to completion.
8. Verify the published Release and both installer assets.

## Version Sources

A release version must be synchronized in all five files:

- `package.json`: root `version`
- `src-tauri/Cargo.toml`: `[package].version`
- `src-tauri/Cargo.lock`: the `[[package]]` entry whose name is `anhe-player`
- `src-tauri/tauri.conf.json`: root `version`
- `release/version.json`: `version` and `changeLog`

Do not edit `pnpm-lock.yaml` solely for an application version bump.

Keep `release/version.json.download` as:

```json
["https://anhe-player.loc.cc"]
```

unless the user explicitly changes the official download policy.

## Preflight

Read the current repository and authentication state:

```bash
git status --short --branch
git log --oneline -5
git tag --sort=-version:refname | head -10
gh auth status
```

Read the five version sources and the actual workflow before editing. If the worktree was already dirty, inspect every change and preserve unrelated user work.

If the user did not specify a version, increment the patch version. Before using it, confirm that neither a local/remote tag nor a GitHub Release already exists:

```bash
git tag -l v<VERSION>
git ls-remote --tags origin refs/tags/v<VERSION>
gh release view v<VERSION> --repo raclen/AnhePlayer \
  --json tagName,name,isDraft,isPrerelease,url,assets 2>&1 || true
```

Never reuse an existing version unless the user explicitly asks to repair that release.

## Edit Release Metadata

Update all five version sources. `release/version.json.changeLog` must contain concise, user-facing changes for this release, not internal implementation notes. Keep the official download URL unchanged.

Example consistency check:

```bash
node -e "
const fs = require('fs');
const versions = {
  package: require('./package.json').version,
  release: require('./release/version.json').version,
  tauri: require('./src-tauri/tauri.conf.json').version,
  cargo: fs.readFileSync('./src-tauri/Cargo.toml', 'utf8').match(/^version = \"([^\"]+)\"/m)[1],
  lock: fs.readFileSync('./src-tauri/Cargo.lock', 'utf8').match(/name = \"anhe-player\"\r?\nversion = \"([^\"]+)\"/)[1],
};
console.log(versions);
if (new Set(Object.values(versions)).size !== 1) process.exit(1);
"
```

The tag workflow also rejects a tag whose version does not match `release/version.json.version`.

## Local Verification

Run checks appropriate to the changed files before committing:

```bash
./node_modules/.bin/prettier --check <changed frontend/config/docs files>
./node_modules/.bin/eslint <changed TypeScript/TSX files>
./node_modules/.bin/vite build
rustfmt --edition 2021 --check <changed Rust files>
git diff --check
```

On this development machine, `pnpm` may run a dependency-state check and attempt to reinstall optional packages. When dependencies already exist and only tool execution is needed, call the binaries in `node_modules/.bin` directly instead of repeatedly triggering installation.

The local machine has no usable MSVC linker, so a successful Vite build and `rustfmt --check` do not replace the GitHub Actions Tauri build. The CI result is the Rust/package validation authority.

## Commit And Push Master

Review the complete release diff, then stage only the intended fix, documentation, and version files. Commit messages must be in Chinese and release-focused.

```bash
git add <intended files>
git commit -m "发布：准备 <VERSION>，<简要说明>"
git push origin refs/heads/master:refs/heads/master
```

If local hooks are blocked solely by the known pnpm non-interactive dependency check, first run the equivalent Prettier/ESLint/build checks manually, then use `git commit --no-verify`. Do not use `--no-verify` to bypass a real check failure.

After pushing, require the remote `master` SHA to match local `HEAD`:

```bash
git rev-parse HEAD
git ls-remote origin refs/heads/master
```

## Create The Release Tag

Create an annotated tag on the verified release commit and push the explicit ref:

```bash
git tag -a v<VERSION> -m "发布 <VERSION>：<简要说明>"
git push origin refs/tags/v<VERSION>
```

Pushing the tag is the release trigger. Do not use `workflow_dispatch` when the goal is to publish a release.

## Watch The Workflow

Locate the run whose `headSha` equals the tagged commit, `headBranch` equals `v<VERSION>`, and event is `push`:

```bash
gh run list --repo raclen/AnhePlayer --workflow tauri-build.yml --limit 5 \
  --json databaseId,headSha,headBranch,event,status,conclusion,createdAt,url,displayTitle
```

Watch it to completion:

```bash
gh run watch <RUN_ID> --repo raclen/AnhePlayer --exit-status
```

Keep the user informed while the run is active. Do not declare success while the workflow is still running.

The current workflow has one expected job:

- `build-tauri (windows-latest)`

Important steps include:

- Verify `release/version.json` matches the tag
- Build Tauri App
- Upload Windows Artifacts
- Generate release notes from `release/version.json`
- Publish GitHub Release

## Expected Outputs

A successful tag build should create:

1. An Actions artifact named `AnhePlayer-Tauri-Windows`, containing the release EXE/MSI outputs.
2. A non-draft, non-prerelease GitHub Release named `AnhePlayer v<VERSION>`.
3. Both public Windows installer assets (version substituted):

```text
AnhePlayer_<VERSION>_x64-setup.exe
AnhePlayer_<VERSION>_x64_en-US.msi
```

4. `latest.json` and the matching `.exe.sig` / `.msi.sig` updater signatures. The manifest must contain `windows-x86_64`, `windows-x86_64-nsis`, and `windows-x86_64-msi`, with this version's URLs and embedded signature text.

应用内更新从 1.0.42 开始接入：构建依赖 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Secrets 与客户端内置公钥。签名必须绑定发布版本，禁止随意更换密钥。标签构建先创建草稿 Release，`verify-updater-assets.mjs` 校验安装包、签名和清单后才公开；dispatch 仅验证签名产物，不发布。旧版需先手动安装含 updater 的版本，之后再进行应用内升级。

The workflow currently publishes Windows only. Do not expect macOS/Linux assets or a portable ZIP.

## Failure Handling

Inspect the failed job and logs before changing code or rerunning:

```bash
gh run view <RUN_ID> --repo raclen/AnhePlayer --json status,conclusion,jobs,url
gh run view <RUN_ID> --repo raclen/AnhePlayer --log-failed
```

Rules:

- Version guard failure: fix all version sources, commit, and create a new tag. Do not move an already published tag silently.
- Compile/package failure: fix the root cause, push a new commit, and normally bump to the next patch version if the failed tag was already published or externally visible.
- Transient GitHub artifact/network failure: rerun failed jobs, then re-check both the Actions artifact and Release assets.
- Do not call a release complete when the workflow succeeded but public assets are missing.

For a validation-only build with no Release, explicitly use:

```bash
gh workflow run tauri-build.yml --repo raclen/AnhePlayer --ref master
```

A dispatch run creating a tag or Release is a workflow regression and must be fixed before further releases.

## Post-Release Verification

Verify the run, tag, Release, and assets:

```bash
gh run view <RUN_ID> --repo raclen/AnhePlayer --json status,conclusion,url,jobs
gh release view v<VERSION> --repo raclen/AnhePlayer \
  --json tagName,name,isDraft,isPrerelease,publishedAt,url,assets
git fetch --tags origin v<VERSION>
git show --no-patch --pretty=fuller v<VERSION>
git status --short --branch
```

Required final state:

- Workflow conclusion is `success`.
- Tag `v<VERSION>` points to the intended release commit.
- Release is neither draft nor prerelease.
- Both NSIS setup EXE and MSI assets are visible.
- Local `master` matches `origin/master` and the worktree contains no unintended changes.

## Final Response

Keep the final report short and concrete. Include:

- released version
- release URL
- release commit hash
- workflow run URL
- the two published asset names
- any rerun or recovery action taken

Never say the release is complete before `gh release view` confirms the public assets.
