# Panel macOS 客户端

Panel 现在提供可本地运行的 macOS 应用。原生外壳使用 Swift、AppKit 和 WKWebView，内置独立 Node.js 运行时与生产版前后端，打开应用即可启动本地服务，无需另外运行开发服务器或安装 Node.js。

当前构建面向 macOS 13.5 及以上版本，提供原生窗口与菜单、系统文件夹选择器、模型配置入口、应用数据与日志入口。工作台继续使用现有的探索画布、模型调用、工具审批和持久化逻辑。

客户端从与 Web 版相同的 `src/`、`server/` 和 `shared/` 构建，包含画布分支输入卡片、模型上下文容量和路径占用显示，以及文件更新的 Git 记录。Git 快照沿用 Web 版的本机 Git 依赖；应用内置 Node，不内置 Git。

## 首次使用

1. 解压对应架构的 `Panel-mac-arm64.zip` 或 `Panel-mac-x64.zip`，打开其中的 `Panel.app`；也可先将应用移入「应用程序」文件夹。
2. 等待「正在启动 Panel」结束。客户端会自动启动只监听本机的服务，准备应用自己的数据目录。
3. 没有模型密钥时，可以用 Pi Demo 体验探索和分支。演示模型使用预设回复，不执行本地或联网工具。
4. 使用真实模型前，按下一节配置供应商密钥。

从探索根节点打开工作目录设置，点击「从 Mac 选择文件夹」即可使用系统选择器。选中路径只更新目录草稿，仍需在工作台内确认保存；取消选择不会改变目录。有运行中或排队中的任务时，不能切换工作目录。

按住红绿灯所在的顶部空白区域可拖动窗口；双击该区域可放大到当前屏幕的可用桌面区域，再次双击恢复原尺寸。此操作保留菜单栏和 Dock，不进入独立全屏空间；「窗口 → 缩放」也使用相同行为。

常用快捷键：

| 操作         | 快捷键 |
| ------------ | ------ |
| 新建探索     | `⌘N`   |
| 搜索探索     | `⌘K`   |
| 打开模型配置 | `⌘,`   |
| 重新加载页面 | `⌘R`   |
| 关闭窗口     | `⌘W`   |
| 退出应用     | `⌘Q`   |

## 自动更新（v0.5 起）

App 启动后检查 `H0ypothesis/panel` 的 GitHub Release，之后每 24 小时检查一次；关闭期间不运行后台检查，下次打开时补查。检查时间和已发现的更新会保留，升级到新版本后会重新检查。也可随时选择「Panel → 检查更新…」。

发现高于当前版本且匹配 CPU 架构的安装包后，左下角版本号旁显示「有更新」。点击后自动下载并显示进度，核对 GitHub 资产的大小和 SHA-256，再检查应用标识、版本、最低 macOS 要求、CPU 架构和代码签名。校验通过后停止本地服务、替换当前 App 并重新打开；数据目录和模型配置保留。

有运行或排队任务时暂不开始更新，下载结束后还会复查。请等待任务完成或手动停止后再点击。下载或校验失败可点击「重试更新」；替换或启动命令失败时尝试恢复旧 App。安装位置必须可写，磁盘映像或只读目录中的 App 需先移到「应用程序」。

更新源固定为本项目的公开 GitHub Release，无需 GitHub 登录。发布标签应使用 `v0.5`、`v0.5.1` 这样的数字版本，附带对应的 `Panel-mac-arm64.zip` 或 `Panel-mac-x64.zip`，并由 GitHub 提供 `sha256:` 资产摘要。普通数字标签即使标为预览版也会参与检查；草稿、`-beta` / `-rc` 标签、旧的日期型标签、缺少摘要或不匹配架构的安装包会跳过，不会降级。

开发验证运行 `npm run test:updater`。它覆盖版本选择、下载校验、ZIP 路径与符号链接约束、失败恢复和前端进度交互，使用本地夹具，不替换正在使用的 App。

## 模型配置与数据位置

在工作台打开「模型连接」，点击供应商右侧「未配置」或「已配置」，即可在子页填写 API URL、Key 和 Model。保存后立即生效，无需重启；再次编辑时密钥留空会保留原值。

界面配置保存在 `~/Library/Application Support/Panel/data/model-providers.json`，优先于该供应商的环境配置，密钥不会返回给页面或随探索导出。

选择菜单「Panel → 模型配置…」，或在工作台的「模型连接」中点击「打开高级配置文件」，仍可用文本编辑打开：

```text
~/Library/Application Support/Panel/.env
```

首次启动会从内置 `.env.example` 创建此文件。按模板填写需要的供应商密钥并保存，再选择「Panel → 重启本地服务…」使配置生效。无需填写所有供应商；模型连接状态可在工作台中查看。仅重新加载页面不会重新读取 `.env`。

客户端将应用文件保存在：

| 内容                       | 位置                                                  |
| -------------------------- | ----------------------------------------------------- |
| 模型与工具配置             | `~/Library/Application Support/Panel/.env`            |
| 探索状态与空间默认工作目录 | `~/Library/Application Support/Panel/data/`           |
| 探索状态文件               | `~/Library/Application Support/Panel/data/state.json` |
| 本地服务日志               | `~/Library/Application Support/Panel/server.log`      |

「Panel → 显示数据文件夹」打开 `data` 目录；「帮助 → 显示服务日志」定位日志文件。模型密钥由本地服务读取，不会随探索导出。

客户端的数据和模型配置与源码启动的 Web 版独立。Web 版默认使用项目下的 `.env` 和 `.panel/`，客户端不会自动导入或覆盖它们。两端仍可显式选择同一个本地项目目录；这种情况下，项目文件在磁盘上是共享的。

## 关闭、退出与重启

关闭窗口或按 `⌘W` 会保留应用和本地服务，已有任务继续运行。点击 Dock 中的 Panel 图标可重新打开窗口。

「Panel → 退出 Panel」或 `⌘Q` 会保存探索并停止本地服务。如果仍有运行中或排队中的任务，会先提示确认。重启本地服务也会检查这些任务，并在需要时提示确认。

退出或重启会中断尚未完成的任务，已经发生的项目文件修改会保留，不会回滚。再次启动不会自动重放中断的模型请求。工作台内的工具审批规则仍然生效，命令依旧在本机执行。

## 从源码构建

构建需要 macOS、Xcode Command Line Tools，以及 Node.js ≥ 22.19。尚未安装命令行工具时，可运行：

```bash
xcode-select --install
```

首先按项目的源码安装流程初始化 Pi 子模块、安装依赖并生成模型目录。在项目根目录执行：

```bash
git submodule update --init --recursive
npm ci --ignore-scripts
npm run setup:pi
```

应用内置的 Node 必须是与当前构建进程及依赖相同架构的官方 macOS 独立版本。Apple Silicon 使用 `arm64`，Intel 使用 `x64`。将官方 Node 压缩包解压后，设置 `PANEL_NODE_BINARY` 指向其中的 `bin/node`：

```bash
PANEL_NODE_BINARY="/absolute/path/to/node-v24.19.0-darwin-arm64/bin/node" npm run build:mac
npm run test:desktop
```

`PANEL_NODE_BINARY` 未设置时，构建脚本使用当前执行 npm 的 Node。脚本会检查 Node 版本、架构和动态库依赖；依赖 Homebrew 等外部动态库的 Node 会被拒绝，避免生成只能在构建机上启动的应用。

构建会随应用保留 Node 许可证。`PANEL_NODE_LICENSE` 默认指向 Node 安装目录的 `LICENSE`，即从 `bin` 目录解析 `../LICENSE`；文件位于其他位置时可显式指定：

```bash
PANEL_NODE_BINARY="/absolute/path/to/bin/node" \
PANEL_NODE_LICENSE="/absolute/path/to/LICENSE" \
npm run build:mac
```

`npm run build:mac` 依次构建 Web 资源、打包独立后端及运行依赖、编译原生外壳并生成应用图标，最后进行本地 ad-hoc 签名和签名验证。产物为：

```text
release/Panel.app
release/Panel-mac-arm64.zip   # 或 Panel-mac-x64.zip
release/build-info.json
```

当前为单架构构建，不生成 Universal 应用。`build-info.json` 记录应用版本、架构、Node 版本、签名方式与构建时间。构建会替换同目录下的已有应用和对应架构 ZIP。

## 验证记录与发布状态

本轮实际验证使用 Apple Silicon `arm64`、独立 Node.js `24.19.0`，最低系统版本按 Node 二进制要求设为 macOS 13.5。已通过：

- `npm run check`：前后端 TypeScript 检查。
- `npm run test:core`：161 项核心测试，包含实际 Git 快照与历史记录。
- `npm run test:desktop`：独立运行时和前端资源、模型目录、Pi Demo 流式执行、幂等提交、SSE、导出接口、来源校验、持久化、端口复用与冲突回退、正常关闭、父进程退出清理，以及打包后的搜索、网页提取和 PDF 运行依赖加载。
- 最新同步包的前端资源与 Web 版 `dist` 逐字节一致，后端与本次源码构建产物一致。另用本机模拟模型验证了打包后端的人工审批写入、真实 Git 提交与历史持久化，未调用远程模型。
- 原生界面实测：应用启动、`⌘N` 新建探索、`⌘K` 搜索、系统目录选择器路径回传、取消目录草稿修改、原生保存面板导出有效 JSON 文件，以及 `⌘Q` 后窗口与后台服务正常退出。

`test:desktop` 默认直接使用已构建 `Panel.app` 内的运行时，在隔离临时目录中测试，不继承实际模型密钥或使用现有探索数据；它不替代原生界面的交互验收。

当前产物采用本地 ad-hoc 签名，尚未接入 Developer ID 签名或 Apple 公证，属于预览版。v0.5 起提供上述 GitHub Release 更新功能；签名校验用于检查包的完整性，发布来源由固定仓库的 HTTPS 地址和 GitHub 资产摘要约束。
