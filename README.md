# Panel

基于 Pi 的非线性 Agent 工作台。对话是一张图，每轮对话是一个节点；从任意已完成的节点继续，只继承该节点到根的路径，可以让多个方向同时运行。

产品定义、边界和验收标准见 [PRD](docs/PRD.md)。

![Panel 非线性 Agent 工作台](docs/assets/workbench.png)

## 启动

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

没有 API Key 也可体验完整工作流。默认提供 **Pi Demo 演示模型**和明确标注的示例探索。演示模型使用真实 Pi Agent 和 faux provider 流式执行预设回复，不是远程模型推理，不产生模型费用。

## 真实模型

复制 `.env.example` 为 `.env`，填写所需供应商，再重启服务：

```dotenv
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
```

无需填写全部供应商。模型目录与支持的思考等级取自 Pi。界面左下角「模型连接」显示配置状态，节点输入区可以单独选择模型与思考强度。环境变量已存在时优先使用环境变量。

首版支持 API Key/Anthropic token 环境变量；不会读取 Pi CLI 的 OAuth 登录状态。模型密钥只在服务端使用，不保存在浏览器或导出文件中。

## 使用

- 新建探索：填写主题和可选背景，得到根节点。
- 点击节点卡片的 `+`，或选择节点后在右侧输入问题，创建子节点。
- 在「上下文路径」查看下一轮会继承的问答。画布高亮当前父链。
- 生成时可以选择其他节点继续提问。最多 3 个并行运行，后续请求排队。
- 「新分支重试」把原问题放入父节点输入区，可修改模型和问题后再发送。
- 取消只影响当前节点；未完成的节点不能作为后续上下文，需要从父节点继续。
- 搜索：`⌘/Ctrl K`；聚焦输入：`B`；发送：`⌘/Ctrl Enter`。
- 拖拽节点、缩放、自动布局、适配画布和小地图可用于整理结构。
- 导出菜单支持完整探索 JSON（含原始模型消息）和选中路径 Markdown。

## 数据与运行

数据保存于 `.panel/state.json`，写入串行化并通过原子重命名落盘；流式过程每秒保存，节点创建/结束立即保存。浏览器关闭不终止运行。服务重启将未结束节点标为失败，不自动重复模型请求。

可配置 `PORT`（默认 4317）、`PANEL_DATA_DIR`（默认 `.panel`）。服务只监听 `127.0.0.1`，设计用于本机单用户。不要对同一个数据目录同时启动多个服务实例。首版不提供文件写入、Shell、账号或公开分享。

```bash
npm run check       # 前后端 TypeScript 检查
npm run test:core   # 分支、并行、取消、恢复、API 和真实 Pi 演示运行测试
npm run build      # 生成前端发布文件
npm start          # 本地生产模式，仍需要 node_modules 与 pi/ 源码
```

## 目录

```text
docs/PRD.md      产品需求文档
src/            React 工作台和图画布
shared/         对话图类型、路径与布局逻辑
server/         HTTP API、SSE、Pi 适配、队列与持久化
pi/             上游 Pi 源码子模块，固定版本，不修改其业务代码
```

当前验证覆盖演示模型与本地工作流。真实供应商端到端调用需要自行配置有效凭证。
