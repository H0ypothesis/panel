# 开发与运行

[返回项目首页](../README.md)

模型密钥配置见[模型配置](CONFIGURATION.md)，桌面应用构建见 [macOS 客户端说明](MACOS.md#从源码构建)。

## 安装与启动

需要 Node.js ≥ 22.19。`pi/` 以 Git 子模块固定到已验证的上游版本，克隆时一并拉取：

```bash
git clone --recurse-submodules https://github.com/H0ypothesis/panel.git
cd panel
npm ci --ignore-scripts
npm run setup:pi
npm run dev
```

如果已克隆但没有初始化子模块，先运行 `git submodule update --init --recursive`。依赖升级或修改依赖时使用 `npm install --ignore-scripts`。

打开 <http://127.0.0.1:4317>。`setup:pi` 使用 Pi 自带生成器下载模型元数据，首次运行或升级 Pi 后执行一次；随后启动和演示模式可离线使用。

安装入口兼容 models.dev 将 `kimi-for-coding` 拆分为区域目录的变化：把与当前 Pi `api.kimi.com` 端点对应的 `kimi-code-plan-cn` 映射回生成器使用的名称。仍保留 `--strict --data-only` 校验；网络失败或供应商目录确实缺失时会报错。遇到 `Cannot hydrate missing providers: kimi-coding` 时，更新 Panel 后重新运行 `npm run setup:pi`。

没有 API Key 也可体验对话分支工作流。默认提供 **Pi Demo 演示模型**和明确标注的示例探索。演示模型使用真实 Pi Agent 和 faux provider 流式执行预设回复，不是远程模型推理，不产生模型费用，也不会执行本地或联网工具。

## 数据与运行

数据保存于 `.panel/state.json`，写入串行化并通过原子重命名落盘；流式过程每秒保存，节点创建/结束立即保存。浏览器关闭不终止运行。服务重启将未结束节点标为失败，不自动重复模型请求。

开发模式只对前端热更新。修改 `server/` 或服务端使用的共享代码后，需等待当前任务结束并重启服务。发送带卡片引用的任务前，前端会确认后端已加载引用功能；旧版本服务会明确提示重启，并保留草稿，不会仅发送引用标题而丢失正文。

可配置 `PORT`（默认 4317）、`PANEL_DATA_DIR`（默认 `.panel`）。服务只监听 `127.0.0.1`，设计用于本机单用户。不要对同一个数据目录同时启动多个服务实例。首版不提供账号或公开分享，工作目录、审批模式和工具记录随探索一起保存。

```bash
npm run check       # 前后端 TypeScript 检查
npm run test:setup  # 安装时的模型目录兼容与严格校验回归测试（无需联网）
npm run test:core   # 分支、审批、目录调度、本地与联网工具、取消、恢复、API 和 Pi 演示测试
npm run build      # 生成前端发布文件
npm start          # 本地生产模式，仍需要 node_modules 与 pi/ 源码
```

## MCP 扩展准备

项目已预装 [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) `2.34.0`，版本固定在 `package.json` 和锁文件中，随 `npm ci --ignore-scripts` 安装，用于后续接入更多 MCP 服务。

当前 Panel 直接创建 Pi Agent，尚未加载该适配器；添加 `.mcp.json` 或在 Pi CLI 中安装扩展不会自动为 Panel 启用 MCP 工具。后续接入需要配置服务、注册工具，并衔接现有审批、调用记录、取消与连接清理流程。macOS 打包目前也未包含该适配器，启用时需同步补充打包与验证。

## 目录

```text
docs/PRD.md      产品需求文档
src/            React 工作台和图画布
shared/         对话图类型、路径与布局逻辑
server/         HTTP API、SSE、Pi 适配、队列与持久化
pi/             上游 Pi 源码子模块，固定版本，不修改其业务代码
```

当前自动化验证覆盖演示模型、临时目录中的实际文件读写与命令执行、审批和本地工作流；没有把这些检查当作真实供应商端到端验证。真实模型调用需要配置有效凭证。

详细验收范围见[产品需求](PRD.md)和[首版验收记录](VERIFICATION.md)。
