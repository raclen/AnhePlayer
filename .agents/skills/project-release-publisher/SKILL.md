---
name: project-release-publisher
description: Run the AnhePlayer project release workflow end to end. Use this skill whenever the user asks to bump/increase the version, rerun GitHub Actions packaging, publish to GitHub Release, fix a release with missing assets, package installers, create a new tag, or "发版/打包/发布到 release". This skill is specifically for this repository's package.json + release/version.json + build.yml + release.yml flow and should be used even if the user phrases the request casually.
---

# Project Release Publisher

Use this skill to release AnhePlayer through GitHub Actions without skipping the packaging step.

The release has two separate workflows:

- `.github/workflows/build.yml`: manually builds artifacts for Windows, macOS, and Linux.
- `.github/workflows/release.yml`: manually takes a successful Build run ID, downloads its artifacts, creates/reuses the tag, and publishes/uploads GitHub Release assets.

The usual goal is: bump version, commit and push, run Build, verify artifacts, run Release, verify the published release.

## Release Files

Update these files for a normal version bump:

- `package.json`: root `version`
- `release/version.json`: `version` and `changeLog`

Do not edit `pnpm-lock.yaml` just for the app version; this project's lockfile does not store the root package version.

Keep `release/version.json.download` unless the user explicitly gives a new download link.

## Preflight

Start by reading the current state:

```bash
git status --short --branch
git log --oneline -5
git tag --sort=-version:refname | head -10
node -p "require('./package.json').version"
sed -n '1,160p' release/version.json
gh auth status
```

Also check whether the target version already exists:

```bash
gh release view v<VERSION> --repo raclen/AnhePlayer --json tagName,name,isDraft,isPrerelease,url,assets 2>&1 || true
git ls-remote --tags origin v<VERSION>
```

If the worktree is dirty before the release work starts, inspect the changes. Do not overwrite unrelated user changes. If unrelated changes exist, leave them alone and only stage the release files you touched.

## Choose Version

If the user gives an explicit version, use it.

If the user asks to "upgrade the version" without a number, increment the patch version:

- `1.0.9` -> `1.0.10`
- `1.0.10` -> `1.0.11`

Avoid reusing a version that already has a tag or published release unless the user explicitly asks to repair that existing release.

## Edit Version Metadata

Update `package.json` and `release/version.json`.

The `release/version.json.changeLog` should describe the user-facing release. If the version is primarily a republish to fix missing assets, say that clearly and include the feature/fix summary from the intended release.

After editing:

```bash
node -e "const pkg=require('./package.json'); const rel=require('./release/version.json'); console.log(pkg.version, rel.version); if (pkg.version !== rel.version) process.exit(1)"
pnpm exec prettier --check package.json release/version.json .github/workflows/release.yml
git diff -- package.json release/version.json .github/workflows/release.yml
```

If you change workflow files, include them in the formatting check. If you only changed version files, checking those two files is enough.

## Commit And Push

Commit only the release-related files.

```bash
git add package.json release/version.json
git commit -m "chore: prepare <VERSION> release"
git push origin master
```

If workflow fixes are required to make release reliable, stage those files too and keep the commit message release-focused.

## Trigger Build

Run the Build workflow from `master`:

```bash
gh workflow run build.yml --repo raclen/AnhePlayer --ref master
sleep 5
gh run list --repo raclen/AnhePlayer --workflow Build --limit 5 --json databaseId,headSha,status,conclusion,createdAt,url,displayTitle
```

Pick the run whose `headSha` equals the commit you just pushed.

Watch it to completion:

```bash
gh run watch <BUILD_RUN_ID> --repo raclen/AnhePlayer --exit-status
```

Keep the user updated while long jobs run. Do not finish your turn while a watch or packaging session is still running.

## Expected Build Jobs

Expected jobs:

- `build-meta`
- `build-windows`
- `build-macos-x64`
- `build-macos-arm64`
- `build-linux`
- `build-windows-legacy` is intentionally skipped because `if: false`

Expected artifacts after a successful build:

```text
build-meta
AnhePlayer-<VERSION>-win32-x64-setup
AnhePlayer-<VERSION>-win32-x64-portable
AnhePlayer-<VERSION>-darwin-x64
AnhePlayer-<VERSION>-darwin-arm64
AnhePlayer-<VERSION>-linux-amd64-deb
AnhePlayer-<VERSION>-linux-amd64-rpm
```

Verify artifacts with:

```bash
gh api repos/raclen/AnhePlayer/actions/runs/<BUILD_RUN_ID>/artifacts --paginate \
  --jq '.artifacts[] | [.name, .size_in_bytes, .expired] | @tsv' | sort
```

The Release workflow will upload these six files:

```text
AnhePlayer-<VERSION>-win32-x64-setup.exe
AnhePlayer-<VERSION>-win32-x64-portable.zip
AnhePlayer-<VERSION>-darwin-x64.dmg
AnhePlayer-<VERSION>-darwin-arm64.dmg
AnhePlayer-<VERSION>-linux-amd64.deb
AnhePlayer-<VERSION>-linux-amd64.rpm
```

## Handling Build Failures

If the build fails before packaging, inspect the failed job log and fix the underlying issue before release:

```bash
gh run view <BUILD_RUN_ID> --repo raclen/AnhePlayer --json status,conclusion,jobs,url
gh run view <BUILD_RUN_ID> --repo raclen/AnhePlayer --job <JOB_ID> --log | tail -220
```

Do not publish a release from a failed build unless you have verified all required artifacts exist.

If a job succeeds through packaging but fails only on `actions/upload-artifact` with a transient network error such as `Failed to CreateArtifact: Unable to make request: ENOTFOUND`, rerun failed jobs:

```bash
gh run rerun <BUILD_RUN_ID> --repo raclen/AnhePlayer --failed
gh run watch <BUILD_RUN_ID> --repo raclen/AnhePlayer --exit-status
```

Then re-check the artifact list. This exact transient failure has happened on `build-macos-x64`; rerunning the failed job is the right first recovery.

## Trigger Release

Only run Release after Build concludes `success` and the artifact list is complete.

```bash
gh workflow run release.yml --repo raclen/AnhePlayer --ref master -f run_id=<BUILD_RUN_ID>
sleep 5
gh run list --repo raclen/AnhePlayer --workflow Release --limit 5 --json databaseId,headSha,status,conclusion,createdAt,url,displayTitle
```

Pick the Release run whose `headSha` equals the release commit. Watch it:

```bash
gh run watch <RELEASE_RUN_ID> --repo raclen/AnhePlayer --exit-status
```

The Release workflow reads `build-meta/build-meta.json`, so the tag and release version come from the Build run, not from a locally typed version.

## Post-Release Verification

Verify all of these before telling the user it is done:

```bash
gh release view v<VERSION> --repo raclen/AnhePlayer --json tagName,name,isDraft,isPrerelease,publishedAt,url,assets
git fetch --tags origin v<VERSION>
git show --no-patch --pretty=fuller v<VERSION>
gh run view <BUILD_RUN_ID> --repo raclen/AnhePlayer --json status,conclusion,url
gh run view <RELEASE_RUN_ID> --repo raclen/AnhePlayer --json status,conclusion,url
git status --short --branch
```

The final release should normally be:

- `isDraft: false`
- `isPrerelease: false` for `master` releases
- exactly six uploaded installer/package assets
- tag `v<VERSION>` pointing to the release commit
- Build and Release workflow runs both `success`

## Repairing An Existing Release With Missing Assets

If the user asks to repair an already published release, first check whether a successful Build run exists for the same commit and version.

If it does, you can run `release.yml` with that Build run ID; the workflow now reuses an existing tag and uploads assets with `--clobber`.

If the user asks for a clean new release instead, bump to the next patch version and use the normal flow.

## Final Response

Keep the final response short and concrete. Include:

- version released
- release URL
- commit hash
- Build run URL
- Release run URL
- list of uploaded assets or asset count
- any recovery action taken, such as rerunning a failed macOS x64 upload job

Do not say the release is complete until GitHub Release assets are visible through `gh release view`.
