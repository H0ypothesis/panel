# 模型配置

[返回项目首页](../README.md)

以下配置适用于从源码启动的服务。macOS 应用的配置入口与文件位置见 [macOS 客户端说明](MACOS.md#模型配置与数据位置)。

## 真实模型

复制 [.env.example](../.env.example) 为 `.env`，填写所需供应商，再重启服务：

```dotenv
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
```

无需填写全部供应商。模型目录与支持的思考等级取自 Pi。界面左下角「模型连接」显示配置状态，对话输入框下方可以单独选择执行模型与思考强度。环境变量已存在时优先使用环境变量。

也支持 Paperbypass 网关。在 `.env` 中配置后重启，Luna Pro 和 `Atria-Dawn-Preview` 会出现在模型列表的 Paperbypass 分组中，共用同一个网关密钥：

```dotenv
PAPERBYPASS_API_KEY=你的密钥
PAPERBYPASS_BASE_URL=https://aigateway.paperbypass.com/api
PAPERBYPASS_MODEL=openai/gpt-5.6-luna-pro
PANEL_DEFAULT_MODEL=paperbypass/openai/gpt-5.6-luna-pro
```

网关通过 `Authorization: Bearer` 调用 `/api/v1/messages`，支持流式文本对话和工具调用。通过 Paperbypass 使用 Atria 只需 `PAPERBYPASS_API_KEY`，无需配置直连服务的 `ATRIA_API_KEY`；如需设为默认模型，将 `PANEL_DEFAULT_MODEL` 改为 `paperbypass/Atria-Dawn-Preview`。

`PANEL_DEFAULT_MODEL` 决定从探索起点发起对话时的默认模型；历史对话仍继承各自的模型设置。`PAPERBYPASS_MODEL` 可替换默认的 Luna Pro 模型 ID，Atria 选项始终保留。当前网关配置不发送额外思考参数，Atria 采用其[官方文档](https://api.atria-asi.ai/docs)中的 256,000 上下文窗口，其余模型采用 128,000 的本地上下文预算，输出上限均为 8,192，不提供网关费用估算。

首版支持 API Key/Anthropic token 环境变量；不会读取 Pi CLI 的 OAuth 登录状态。模型密钥只在服务端使用，不保存在浏览器或导出文件中。

Atria 使用 [官方文档](https://api.atria-asi.ai/docs) 的 Messages 接口，在 `.env` 中添加：

```dotenv
ATRIA_API_KEY=你的密钥
ATRIA_BASE_URL=https://api.atria-asi.ai
ATRIA_MODEL=Atria-Dawn-Preview
```

重启后可在模型选择器中选择 `Atria-Dawn-Preview`。该接口通过 `x-api-key` 调用 `/v1/messages`，支持流式文本对话，上下文窗口为 256,000 tokens。Panel 采用 8,192 tokens 的本地输出预算，不发送额外思考参数，不提供 Atria 费用估算。如需设为默认模型，将 `PANEL_DEFAULT_MODEL` 改为 `atria/Atria-Dawn-Preview`。

小米 MiMo Token Plan 中国区使用 [官方 Token Plan 接口](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access)，在 `.env` 中添加：

```dotenv
XIAOMI_TOKEN_PLAN_CN_API_KEY=你的订阅密钥
XIAOMI_TOKEN_PLAN_CN_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
```

重启后，「小米 MiMo Token Plan」分组会显示 `mimo-v2.6-pro`、`mimo-v2.6-flash` 和 `mimo-v2.5-pro`。使用 Token Plan 的 `tp-` / `ttp-` 密钥，通过 Chat Completions 接口流式调用；按量计费接口的密钥不能替代订阅密钥。如需设为默认模型，可设置 `PANEL_DEFAULT_MODEL=xiaomi-token-plan-cn/mimo-v2.6-pro`。

三款模型的上下文窗口为 1,048,576 tokens；Panel 的本地单次输出预算为 16,384 tokens。v2.6 Pro / Flash 支持图片输入，v2.5 Pro 在 Panel 中使用文本输入。思考选项为「关闭」和「高」（开启），对应官方的思考开关；工具调用后的历史会保留 `reasoning_content`。Token Plan 不显示单次费用估算。

搜索服务的可选配置见[网页搜索与网页、PDF 读取](TOOLS.md#网页搜索与网页pdf-读取)。
