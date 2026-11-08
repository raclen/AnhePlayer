# PROJECT_RULES.md

> 记录本项目**长期有效、可复用**的经验、踩坑、约束与关键决策。
> 只记录值得长期记住的内容；一次性需求与临时方案不入册。

---

## 一、性能与内存

### 1.1 WebView 内存分析必须按进程分解实测，禁止凭直觉优化

**触发信号**：有人反馈「空载内存占用高」「内存能不能优化」。

**根因/约束**：WebView/Chromium 是多进程架构。不同进程的内存成因和优化手段完全不同，凭直觉猜测几乎必然指向错误方向。

**正确做法**：先分解，再决策。

```powershell
$perf = @{}
Get-CimInstance Win32_PerfRawData_PerfProc_Process | ForEach-Object { $perf[[int]$_.IDProcess] = $_.WorkingSetPrivate }
Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*anhe*' } | ForEach-Object {
  $cl = [string]$_.CommandLine; $t = 'browser'
  if ($cl -match '--type=([a-zA-Z-]+)') { $t = $Matches[1] }
  if ($cl -match '--utility-sub-type=([a-zA-Z0-9._]+)') { $t = $t + ':' + ($Matches[1] -replace '\.mojom\..*','') }
  New-Object PSObject -Property @{ Role = $t; MB = [math]::Round($perf[[int]$_.ProcessId]/1MB,1) }
} | Sort-Object MB -Descending | Format-Table -AutoSize
```

**验证方式**：各进程 `WorkingSetPrivate` 之和应约等于任务管理器显示的数字（实测 240.8MB vs 244.5MB，吻合）。
注意 `WorkingSet64` 含共享内存，会虚高 2~3 倍（实测总和 737MB），**不要用它下结论**。

**适用范围**：WebView 内存问题。

---

### 1.2 GPU 进程内存高不等于代码有问题 —— 先做同机横向对比

**触发信号**：GPU 进程占了总内存的一半，第一反应是「GPU 有问题」。

**根因/约束**：GPU 进程内存里有很大一块是显卡驱动（ANGLE/D3D11）的固定开销，**与应用代码无关**。在集显机器上尤其明显：没有独立显存，纹理全部从系统内存分配，本该进 VRAM 的开销会直接计入进程内存。

**正确做法**：在**同一台机器**上对比其他 Chromium 应用的 GPU 进程，再判断是否异常。

实测基线（AMD Radeon 核显，1920×1080）：

| 应用           | GPU 进程专用内存 |
| -------------- | ---------------- |
| Chrome         | 251 MB           |
| VS Code        | 225 MB           |
| QQ             | 115 MB           |
| **AnhePlayer** | **103~128 MB**   |
| Edge WebView2  | 79 MB            |

结论：本项目 GPU 进程处于正常偏低水平，**不要把精力投在「压缩 GPU 进程」这个方向**。但这不代表 GPU 里没有可优化项 —— 见 1.3。

**适用范围**：Chromium/WebView 应用的 GPU 内存判断。

---

### 1.3 常驻的 backdrop-filter 是 GPU 内存最大的单点浪费

**触发信号**：全局常驻 UI（侧边栏、播放栏、顶栏）上写了 `backdrop-filter: blur(...)`。

**根因/约束**：`backdrop-filter` 会强制创建 GPU 合成层，并为背景采样保存额外纹理。元素越大、越常驻，代价越高。**当背景色不透明度 ≥ 0.9 时，模糊在视觉上几乎不可见，但 GPU 开销是全额的。**

**正确做法**：

- 不透明度 ≥ 0.9 的背景上不要叠 `backdrop-filter`，直接删除，视觉无损。
- 全宽/全屏的常驻元素优先排查。
- `global.scss` 里已有 `:root.no-blur` 降级开关（把所有 blur token 归零并移除合成层），但**从未被任何代码启用过** —— 若要做「性能模式」设置项，直接复用它即可。

**验证方式**：实测删除 `PlayerBar` 中 `background-color: rgba(25,25,25,0.9)` 上叠加的 `blur(40px)`（一条横跨窗口的常驻伪元素层），GPU 进程 **102.7 MB → 70.3 MB，省约 32 MB**。这是本项目单点收益最大的一处改动，成本只有删 1 行 CSS。

**适用范围**：所有全局常驻 UI 样式。

---

### 1.4 触碰 navigator.mediaDevices 会拉起常驻的 VideoCaptureService 进程

**触发信号**：纯音频应用的进程列表里出现 `utility:video_capture`。

**根因/约束**：Chromium 的 `mediaDevices` 会同时枚举**视频**设备，只要访问它（包括仅 `addEventListener('devicechange')`），就会拉起独立的 VideoCaptureService 进程并常驻至退出。播放器根本不需要视频采集能力。

**正确做法**：懒挂载。仅当用户确实配置了非默认音频输出设备时才注册 `devicechange` 监听 —— 该监听内部本就以 `deviceId === 'default'` 直接 return，懒挂载与原行为完全等价。设置页里的 `enumerateDevices()` 是用户主动行为，可以接受。

**验证方式**：实测进程数 7 → 6，省约 8.5 MB；配置中无 `playMusic.audioOutputDevice` 时 `video_capture` 不再出现。

**适用范围**：所有涉及音频输出设备选择的代码。

---

### 1.5 独立进程有固定成本，不要为轻量任务拆进程

**触发信号**：为了「崩溃隔离」而为逻辑很简单的模块创建独立进程。

**根因/约束**：每个独立进程都有运行时与 V8 堆基线。旧实现中 `requestForwarder` worker 只有 **28KB 代码，却占 16.1 MB**；该数值仅作历史参考。

**正确做法**：纯异步流式 I/O（如 HTTP 转发）通常不需要仅为避免阻塞而额外拆进程，应按当前运行时模型选择任务边界。

**合并后必须补的兜底**（否则未捕获异常会拖垮整个应用，这是失去崩溃隔离的真实代价）：

- `server.on('clientError')` → `socket.destroy()`
- `res.on('error')`（客户端提前断开）
- `targetRes.on('error')`（上游流中断）→ `clientRes.destroy()`
- `dispose()` 用 `closeAllConnections()`，音频是长连接，不能等它自然结束

**验证方式**：实测进程数减 1，`browser(main)` 仅 +2.8 MB，净省约 13 MB。

**适用范围**：独立进程的引入决策。

---

### 1.6 实测基线（AMD Radeon 核显 + 1920×1080，空载=已加载一首歌不操作）

上述 1.3 / 1.4 / 1.5 三项全部实施后的实测对比，**供未来重做时参考**：

| 进程                            | 优化前                | 优化后                | 变化      |
| ------------------------------- | --------------------- | --------------------- | --------- |
| gpu-process                     | 102.7                 | 70.3                  | **−32.4** |
| browser(main)                   | 35.7                  | 38.5                  | +2.8      |
| renderer                        | 36.1                  | 33.8                  | −2.3      |
| utility:node (requestForwarder) | 15.8                  | —                     | **−15.8** |
| utility:video_capture           | 8.5                   | —                     | **−8.5**  |
| utility:network                 | 6.8                   | 6.8                   | 0         |
| utility:audio                   | 5.4                   | 5.5                   | +0.1      |
| **合计**                        | **211.0 MB / 7 进程** | **154.9 MB / 5 进程** | **−27%**  |

注意 GPU 进程内存有波动（同一版本实测到过 102.7 与 128.8），对比时应多次测量取稳定值。

---

## 二、构建与打包

### 2.1 Vite renderer 的动态 import 与 chunk 行为

**触发信号**：把重依赖改成 `import()` 后，bundle 体积没变小。

**当前约束**：桌面端已统一使用 Tauri + Vite。renderer 的 chunk 拆分由 `vite.config.ts` 中的 Rollup/Vite 配置决定。

**正确做法**：即便不拆包，动态 import 仍有价值 —— 模块顶层代码不会在启动时执行，V8 不必立即编译。实测 `hls.js`（540KB，占 main_window 19%，但仅播放 HLS 时才用）改为动态 import 后，renderer 仍降约 2 MB。

**适用范围**：所有「体积大但低频使用」的渲染层依赖。

---

### 2.2 pnpm 版本与 engines 冲突时的构建绕过

**触发信号**：`pnpm package` 报 `ERR_PNPM_UNSUPPORTED_ENGINE`。

**根因/约束**：pnpm 执行脚本时可能先做依赖状态检查；当包管理器版本与现有 `node_modules` 不匹配时，检查可能要求重装依赖或在非交互环境失败。

**正确做法**：使用与 lockfile 和现有依赖目录匹配的 pnpm 版本；只需验证单个工具时，可直接运行 `node_modules` 中对应的 CLI，避免意外重装依赖。

---

### 2.3 Vite 构建必须定义编译期全局常量

**触发信号**：Tauri 版安装后白屏，控制台报 `ReferenceError: __DEV__ is not defined`，且没有任何 React 错误浮层（1.0.19 之前版本的根因）。

**根因/约束**：源码使用编译期常量 `__DEV__`。Vite 构建必须通过 `define` 替换，否则模块顶层求值会抛 ReferenceError 并导致白屏。

**正确做法**：

1. `vite.config.ts` 设置 `define: { __DEV__: JSON.stringify(mode !== 'production') }`（dev server 为 true，build 为 false）。
2. 三个 Vite 入口 HTML（`mainWindow.html` / `lyricWindow.html` / `minimodeWindow.html`）内联「启动早期兜底」脚本：在 `<head>` 中最先注册 `error` / `unhandledrejection` 监听，仅当 `#root` 仍为空时显示错误堆栈，React 挂载成功后自动移除。
3. 新增编译期全局常量时，确保 Vite `define` 配置和源码用法保持一致。

**验证方式**：`vite build` 后 `rg "__DEV__" dist/assets/*.js` 应为零匹配。

**适用范围**：本项目所有 Vite 构建期全局常量。

---

### 2.4 Tauri（WebView2）发布版白屏的远程调试定位法

**触发信号**：已安装的 Tauri 应用白屏，日志目录无输出（启动早期即崩溃，logger 还没跑起来）。

**根因/约束**：发布版无 DevTools 入口，白屏时看不到任何控制台信息，只能靠猜。

**正确做法**：

1. 启动应用前设置环境变量附加远程调试参数：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333 --remote-allow-origins=*'`。
2. 访问 `http://localhost:9333/json/list` 拿页面 target，用 CDP（`Runtime.enable` + `Log.enable` + `Page.reload`）抓取完整加载过程的控制台与未捕获异常堆栈。
3. 避开本机 Chrome 占用的 9222 等端口（Chrome 占 IPv4 时 WebView2 会退到 `[::1]` 监听，容易误判为"端口无响应"）。
4. 端到端验证修复产物（无需重新打包）：启动 Vite dev/preview 后，用 CDP `Page.navigate` 把窗口导航到对应地址，即可在真实 WebView2 中运行当前前端代码。注意此时页面属于 remote origin，Tauri ACL 可能拒绝 `fs_*`、`show_item_in_folder` 等自定义命令；部分桥接会把拒绝静默降级为 `false` 或空数据。remote origin 只用于纯前端交互验证，系统命令与持久化链路必须切回 `tauri.localhost` 或使用 CI 构建的新产物验证。

**验证方式**：CDP 抓到 `[TauriBridge]` 日志序列与具体异常堆栈即定位成功；导航法能直接看到 UI 是否渲染（`#root` 子节点数）。

**自动化实测补充（2026-10-18）**：

1. CDP 驱动长流程（下载、轮询等）时，**页面内 `setTimeout` 在后台窗口会被 Chromium 节流**（约 1 分钟/跳），单条长表达式必然拖死；正确架构是「页面一步操作立即返回 + Node 侧轮询」（Node timer 不节流）。启动调试实例可加 `--disable-background-timer-throttling` 参数。
2. 插件搜索桥 `callPluginMethod({ method: 'search', args: [kw, page, type] })` 的 type 必须用 UI 的 `SearchMediaType`（`music`/`album`/`artist`/`sheet`），传洛雪规范的 `song` 会命中 searcher 空分支，**静默返回空数组**而非报错。
3. **remote origin 页面下 `fs_*` 系列自定义命令会被 ACL 直接拒绝**（报 `Command fs_read_file not allowed by ACL`），JsonFileStore 等容错层会静默降级为空数据——远程调试时「数据全空」优先怀疑 ACL 而非代码或路径（globalContext.appPath 等值本身正常）；数据类验证请在 tauri.localhost 页面进行，纯前端播放链路不受影响。
4. **命令行/CDP 实验里传 Windows 路径禁止手打反斜杠**：bash→JSON→JS 多层转义会把 `\\` 降级为 `\`，而 JS 非法转义序列（如 `\椒`）会静默丢弃反斜杠，产生 `E:椒盐音乐` 这类无效路径（报 os error 3 / 判定不存在），排查时极易误判为「盘符/权限问题」。正确做法：用 `String.fromCharCode(92)` 拼反斜杠，或直接从数据源（JSON 数据）取路径。

**适用范围**：所有 Tauri v2（WebView2）发布版的问题定位。

---

### 2.5 本机无 MSVC 工具链，Tauri 本地构建走 CI

**触发信号**：本地 `tauri build` 在链接阶段报 `link: extra operand '....rcgu.o'`。

**根因/约束**：本机未安装 Visual Studio / MSVC（`C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe` 不存在），rustup 只有 `x86_64-pc-windows-msvc` 工具链；且从 Git Bash 调起 cargo 时，rustc 会把 Git 自带的 GNU `link.exe`（coreutils 硬链接工具）当作 MSVC 链接器调用，报 `extra operand`。

**正确做法**：本地只做前端产物验证（`vite build` / `vite preview` + 2.7 的远程调试法）；完整 Tauri 安装包统一由 GitHub Actions（push v\* 标签触发 `tauri-build.yml`）构建，不要为本地构建硬装 VS。

**适用范围**：本项目所有本地构建/验证决策。

---

### 2.6 发版必须同步 release/version.json（应用内“更新公告”数据源）

**触发信号**：新版本已发布，但应用内「检查更新」提示的仍是旧版本（如 v1.0.19 已发布、公告内容停留在 1.0.16/1.0.18）。

**根因/约束**：`release/version.json` 是发布说明的数据源。应用内更新改为读取正式 Release 的 `latest.json`，通过 Tauri updater 下载并验证安装包；不能再用 master 分支上的公告版本判断更新可安装，否则会在 CI 产物发布前误报新版本。

**正确做法**：

1. 发版前同步 `release/version.json` 与包版本；`changeLog` 同时生成 Release 说明及 `latest.json.notes`。公告中的 download 继续保留官网入口供旧版客户端使用；新版更新弹窗不再打开浏览器。
2. 发布构建必须配置 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，公钥保存在 `tauri.conf.json`。私钥及密码只保存在仓库外和 GitHub Actions Secrets，禁止写入仓库或日志，也不能随意轮换公钥，否则已安装版本无法验证后续更新。
3. 开启 `createUpdaterArtifacts`，先创建草稿 Release，上传并验证安装包、`.sig` 与 `latest.json` 后再公开。Windows 默认选择 NSIS，同时保留 MSI 的安装器类型映射；dispatch 只生成 artifact，不发版。
4. `check_app_update` / `download_app_update` / `install_app_update` 仅接受主窗口调用。更新地址由 Rust 固定，镜像只作为传输回退；禁止开放任意 URL/文件安装、跳过签名或将下载完成事件当作验签成功。
5. 首个包含 updater 的版本仍需用户按旧流程安装一次；之后的签名发布才支持应用内更新。真实安装验证需要新旧两个签名版本，不得把前端构建或模拟下载当作安装闭环。

**验证方式**：标签与各版本配置一致；正式 Release 含 `latest.json`、匹配平台安装包和签名；从旧安装版实测下载、验签、安装重启及用户数据保留。

**适用范围**：所有正式发布流程。

---

### 2.7 Tauri 运行时版本必须从 tauri.conf.json 读取，发版前四处版本号同步

**触发信号**：应用已是最新版却弹「发现新版本」（2026-10-18 实测：应用自报 1.0.19，远端 version.json 已是 1.0.20）。

**根因/约束**：版本号有四个事实源：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`release/version.json`。发版时若漏改其中一个（本次漏 Cargo.toml），而运行时代码用 `env!("CARGO_PKG_VERSION")`（来自 Cargo.toml）自报版本，就会与安装包/远端不一致，更新检查误判为「有新版本」。

**正确做法**：

1. Rust 侧运行时版本一律取 `app.package_info().version`（源自 tauri.conf.json，与安装包对齐），不要用 `env!("CARGO_PKG_VERSION")` 作为对外展示版本。
2. 打标签前四处核对：`node -e` 读 package.json / release/version.json / tauri.conf.json，外加 grep Cargo.toml，必须全部等于目标版本。

**验证方式**：冒烟用例 app-version 回报目标版本号；四方核对命令输出一致。

**适用范围**：所有 Tauri 版发版与对外版本展示。

---

### 2.8 tauri-action 的 tagName 直接取 ref_name 会在 dispatch 构建误建同名标签与 Release

**触发信号**：`git push origin master` 报 `src refspec master matches more than one`；Releases 页出现以分支名（master）为名的 Release；远端多出 `refs/tags/master`。

**根因/约束**：workflow_dispatch 构建时 `github.ref_name` 是分支名；`tauri-action` 的 `tagName: ${{ github.ref_name }}` 会照单在远端创建同名 tag+Release，本地 IDE 自动 fetch 后出现同名 tag，与同名分支一起让短名 push 产生歧义。同类隐患：softprops 步骤 `|| 'v1.0.17'` 兜底，dispatch 勾选 release 会把新产物发到旧版本 Release（已一并移除，发版只由推标签触发）。

**正确做法**：

1. `tagName`/`releaseName` 仅标签构建传值：`${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || '' }}`；发布两步的条件也只看 `startsWith(github.ref, 'refs/tags/v')`。
2. 已被同名 tag 干扰时：`gh release delete master --yes --cleanup-tag` + `git tag -d master`；推送一律用显式 refspec（`refs/heads/master:refs/heads/master`）兜底。

**验证方式**：dispatch 构建后 `gh release list` 与 `git ls-remote --tags` 无分支名条目；标签构建正常发布且含 NSIS/MSI 资产。

**适用范围**：本项目所有 CI 构建与发版流程。

---

### 2.9 本地转发代理必须回写 CORS 头，否则页面侧 fetch 静默失败

**触发信号**：Tauri 版经 forwarder（127.0.0.1 随机端口）的请求在页面侧失败，但用 curl 请求同一代理 URL 返回 200 正常。

**根因/约束**：页面 origin 为 `tauri.localhost`，访问 127.0.0.1 代理属跨源请求；tiny_http 默认响应不带 `Access-Control-Allow-Origin`，浏览器 fetch 直接拒绝读取响应体。curl 不做 CORS 检查，外部测试无法暴露此问题。

**正确做法**：代理的成功与错误响应统一附加 `Access-Control-Allow-Origin: *`；此类功能必须页面内实测（CDP），不能只靠 curl。

**验证方式**：冒烟用例 forwarder-proxy-fetch 在页面内 fetch 代理 URL 返回 200 与正文。

**适用范围**：所有自建本地 HTTP 代理/转发服务。

---

### 2.10 本地媒体播放必须走 asset 协议，且 asset URL 禁止进转发代理

**触发信号**：Tauri 版本地歌曲/已下载歌曲点击播放无声或立即失败。

**根因/约束**：

1. 本地插件返回的播放 URL 是 `http://asset.localhost/...`（WebView2 内部拦截域名，Tauri asset 协议）；转发代理的 `isProxyRequired` 只按协议判断（http/https 一律代理），asset URL 被包进 Rust 转发代理后，reqwest 无法解析 `asset.localhost`，返回 502 `upstream failed`，播放必败（同一 URL 页面直连 fetch 是 200）。
2. 已下载歌曲的 URL 曾走 `file:///`：WebView2 禁止从 http 页面加载 file 资源，audio 报 `MEDIA_ERR_SRC_NOT_SUPPORTED`（error code 4）。

**正确做法**：

1. `isProxyRequired` 显式排除 `asset.localhost`（hostname 判断），asset URL 一律直连。
2. 本地路径 → 播放 URL 统一用 `fsUtil.pathToAssetUrl`（`convertFileSrc(path, 'asset')`），禁止用 `file:///`。

**验证方式**：CDP 里 `new Audio(assetUrl)` 可 loadedmetadata；`fetch(proxyUrl(assetUrl))` 复现 502；播放后 `navigator.mediaSession.playbackState === 'playing'`。

**适用范围**：所有 Tauri/WebView2 下的本地媒体播放与代理判断。

---

### 2.11 测试用例禁止调用「以输入集合为准做删除」的 API（本地库误清事故）

**触发信号**：本地音乐库突然清空（local-music.json 变成空库），但磁盘文件完好。

**根因/约束**：冒烟用例曾调用 `syncScanFolders([临时目录])`——该 API 语义是「以传入的文件夹集合为准做 diff」：不在集合里的既有文件夹及其全部曲目会被移除。当用户曲库已配置扫描文件夹时，用临时目录调用它 = 清空用户全部本地曲目记录。

**正确做法**：

1. 测试/脚本只用命令级原语（`local_scan_dir` / `local_parse_meta`），禁止调用会做「集合 diff 删除」的高层 API。
2. 本地曲目 id = `hashPath(filePath)`（路径稳定哈希）：误清后重新 `syncScanFolders([原文件夹])` 即可恢复，且 **id 与恢复前一致**，歌单/收藏/最近播放的引用自动复原（实测 201 首全量恢复、抽样 id 一致）。

**验证方式**：恢复后 `getAllMusicItems()` 数量与抽样 id 与事故前一致。

**适用范围**：所有涉及用户数据的高层 API 的测试设计。

---

### 2.12 不重编译 Rust 时，当前前端必须在真实 WebView2 中用 CDP 验证

**触发信号**：需要验证右键菜单、键鼠事件、WebView2 默认行为或前端与 Tauri 系统命令的集成，但本机无法构建当前 Rust 宿主。

**根因/约束**：

1. 普通 Chrome 打开 Vite 页面只能证明 React 逻辑，不能证明 WebView2 的原生菜单、Tauri 注入和 ACL 行为。
2. 已安装应用可以作为真实 Tauri/WebView2 宿主，再通过 CDP 导航到 Vite dev/preview，运行工作区里的当前前端代码；但该页面属于 remote origin，`fs_*`、`show_item_in_folder` 等命令可能被 ACL 拒绝。部分桥接会捕获异常并返回 `false`/空数据，看起来像“命令没执行且没报错”。
3. WebView2 的用户数据目录仍被旧的 `msedgewebview2.exe` 占用时，带不同 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 重启应用会报 `HRESULT(0x8007139F)`（“组或资源的状态不是执行请求操作的正确状态”）。这不是前端或 Tauri 代码错误。
4. `Page.captureScreenshot` 只截网页表面，不足以单独证明系统级 Chromium 菜单没有出现；必须结合真实 CDP 输入和事件的 `defaultPrevented` 状态判断。

**正确做法**：

1. **启动当前前端**：优先直接运行现有本地 CLI（如 `./node_modules/.bin/vite --host 127.0.0.1 --port 5173`）。若 `pnpm` 因依赖状态检查尝试重装 optional package，不要反复重试安装；前端构建和 lint 同样可直接调用 `node_modules/.bin` 下的工具。
2. **干净重启调试宿主**：先从现有进程的 `ExecutablePath` 获取安装路径，不要假定安装盘符；关闭 `anhe-player.exe` 后，只清理命令行含 `com.anhe.player` 的残留 WebView2 进程，禁止杀掉系统中全部 `msedgewebview2.exe`：

    ```powershell
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
      Where-Object { $_.CommandLine -match 'com\.anhe\.player' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    ```

3. **启用 CDP 后启动应用**：

    ```bash
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333 --disable-background-timer-throttling" "/实际安装路径/anhe-player.exe"
    ```

    用 `http://127.0.0.1:9333/json` 确认存在 URL 含 `mainWindow` 的 page target，再通过 CDP `Page.navigate` 或 `Runtime.evaluate` 导航到 `http://127.0.0.1:5173/mainWindow.html`。

4. **测试数据只做内存注入**：若 remote origin 因 ACL 读不到本地曲库，可在进入页面前临时替换数据提供者（例如 `localMusic.getAllMusicItems`）返回一条 mock 曲目。禁止为了造数据调用 `syncScanFolders` 等会按输入集合做删除的高层 API，见 2.11。
5. **右键必须用真实 CDP 输入验证**：先在 `document` 冒泡阶段记录 `contextmenu` 的 `defaultPrevented`，再用 `Input.dispatchMouseEvent` 向歌曲行发送 `mousePressed`/`mouseReleased`，`button: 'right'`。不要只用 JS `dispatchEvent`，合成事件不会触发系统默认菜单。

    ```js
    window.__rightClickEvents = [];
    document.addEventListener('contextmenu', (event) => {
        window.__rightClickEvents.push({
            defaultPrevented: event.defaultPrevented,
            text: event.target?.textContent,
        });
    });
    ```

    验证时同时读取：
    - `window.__rightClickEvents.at(-1).defaultPrevented === true`；
    - `document.querySelectorAll('.context-menu').length === 1`；
    - `.context-menu__item-label` 包含预期菜单项；
    - `Page.captureScreenshot` 中只看到应用菜单。

    如果“应用菜单 + Chromium 调试菜单”同时出现，优先检查共享右键入口是否调用 `event.preventDefault()`；`stopPropagation()` 不能阻止浏览器默认菜单。菜单状态使用单一 atom 时，不要先绕去排查重复渲染或 Rust 命令。

6. **系统命令分层验证**：remote origin 下命令失败是 ACL 预期行为。纯系统层验证应先导航回 `http://tauri.localhost/mainWindow.html`，再通过 `window.__TAURI_INTERNALS__.invoke(...)` 调用命令；这一步验证的是已安装宿主中的 Rust 命令，不代表 remote origin 的当前前端已完成端到端集成。若必须验证“当前前端 + 当前 Rust + 用户数据”的完整链路，只能使用 CI 新构建产物或具备 MSVC 的本机 dev build，禁止为调试临时放宽生产 ACL。
7. **验证资源管理器定位结果**：不要只看命令返回 `true`，还要读取 Explorer 当前选中项：

    ```powershell
    $shell = New-Object -ComObject Shell.Application
    foreach ($window in @($shell.Windows())) {
      $selected = @($window.Document.SelectedItems()) | ForEach-Object { $_.Path }
      [pscustomobject]@{ LocationURL = $window.LocationURL; Selected = $selected }
    }
    ```

    `Selected` 必须等于目标文件的绝对路径。验证结束后关闭本次打开的 Explorer 窗口，并清理 Vite 进程、临时文件和测试页面。

**验证方式**：真实 WebView2 中由 CDP `Input.dispatchMouseEvent` 触发右键，事件记录为 `defaultPrevented: true`，页面恰有一个 `.context-menu`；系统命令从 `tauri.localhost` 返回成功，且 Explorer COM 读取到目标文件为当前选中项。

**适用范围**：所有无需重打包即可完成的前端交互验证，以及前端行为与 Tauri 系统能力需要分层排查的场景。

---

## 三、架构决策

### 3.1 桌面端统一使用 Tauri v2

**决策**：旧桌面运行时代码、依赖、原生模块和独立打包链路已移除；桌面端只维护 Tauri v2 + Rust 与 Vite/React 前端。

**保留能力**：LX Music 插件继续由前端 Web Worker 沙箱执行；文件、窗口、下载和系统集成能力由 Rust commands 与 Tauri plugins 提供。不要重新引入旧桌面运行时的主进程、preload 或独立打包链路。

---

### 3.2 语言支持：仅维护简体中文（zh-CN）

**触发信号**：新增或修改功能文案、i18n key 时，习惯性地尝试同步修改或补齐其他语言包。

**根因/约束**：本项目受众与开发维护均以简体中文为主，不需要花费精力适配或同步其他语言。

**正确做法**：

1. **本项目仅支持并维护简体中文（zh-CN）**，所有新增/修改文案与 i18n 键只写入 `res/lang/zh-CN.json`。
2. **禁止**向 `zh-TW.json`、`en-US.json` 等其他语言包追加 key 或做多语言同步，避免无意义的维护开销与冗余代码。

---

### 3.3 应用内网络默认直连，可在设置内手动启用代理

**触发信号**：音源经系统代理返回错误，而直连正常；新增原生 HTTP 客户端、WebView 或更新下载路径；调整网络/代理设置。

**根因/约束**：播放器默认不走 Windows 系统代理与代理环境变量，只允许用户在「设置 → 网络」里显式填写一个 HTTP 代理（含 Basic 认证）。reqwest 默认会读取系统/环境代理，WebView2 与更新器各有独立网络栈，不能只改音频下载客户端；WebView2 的代理只能通过进程启动参数注入，改配置后必须重启才生效。

**正确做法**：

1. 所有原生 HTTP 客户端统一经 `commands::network` 注入策略：`read_settings()` → `apply()` / `apply_blocking()` / `apply_updater()`。默认分支必须调用 `no_proxy()`；构建失败的回退客户端也必须直连。保留各路径原有 TLS、超时、重定向与凭据隔离策略。
2. 局域网（RFC1918）与回环地址通过 `NoProxy` / `--proxy-bypass-list` 始终直连，避免 WebDAV 与插件音源被代理拦截。
3. 创建任何 WebView 前调用 `configure_network()`：默认设 `NO_PROXY`/`no_proxy=*` 并给 WebView2 追加 `--no-proxy-server`；启用代理时改为 `--proxy-server` + `--proxy-bypass-list`。保留已有浏览器参数，不修改 Windows 或代理软件配置。
4. 代理只支持 HTTP 协议（HTTPS 站点走 CONNECT 隧道），不引入 SOCKS5；更新器的代理通过 `UpdaterBuilder::proxy(url)` 注入，认证信息编码进 URL。
5. 保留播放器本地媒体转发服务及其 CORS、Range、`publicOnly`、DNS 绑定等安全边界。更新镜像是显式 HTTPS 请求地址，不属于系统 HTTP 代理，不应删除。

**验证方式**：分别在「直连」与「启用代理」两种配置下验证音源、播放/续传下载、网页资源、网易登录、WebDAV、更新检查与签名下载安装；代理配置变更后需重启应用再验证网页侧。完整原生验证使用 CI 新构建产物，不把旧安装版或仅前端构建当作验证通过。

**适用范围**：应用内 HTTP(S) 网络路径；不控制系统浏览器、VPN/TUN 或透明网络代理。

---

## 四、已知问题（非本次引入）

- `components/ui/MediaGrid` 用裸 `data.map` 渲染，未做虚拟化（`SongTable`/`QueueDrawer` 已用 react-virtuoso）；被 ArtistPage / RecommendSheetsPage / SearchPage 使用，结果集大时是内存隐患。
- `i18next` 在 renderer bundle 中被打了两份（CJS + ESM 各一，约 240 KB），移除 asset-relocator 后依旧，原因未定位。
