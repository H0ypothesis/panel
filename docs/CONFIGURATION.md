# 模型配置

[返回项目首页](../README.md)

Web 版和 macOS 应用均可直接在界面中配置模型。macOS 应用的文件位置见 [macOS 客户端说明](MACOS.md#模型配置与数据位置)。

## 在界面中配置

1. 打开左下角「模型连接」，点击供应商右侧的「未配置」；已有配置时点击「已配置」可继续编辑。
2. 在配置子页填写 API URL 和 API Key，稍作停顿后会自动获取模型列表。URL 为服务商提供的 API 基础地址，不包含 `/chat/completions` 等具体请求路径；地址需要支持所选供应商的接口协议。点击 Model 输入框可浏览、搜索并选择模型，也可手动填写完整模型 ID。
3. 点击「保存配置」，模型列表立即更新，无需重启。保存表示配置已写入本机，不代表已向供应商验证连接。

OpenAI 可选择接口协议：自动模式下，内置模型使用 Responses，自定义模型使用 Chat Completions；使用仅支持 Chat Completions 的兼容网关时，选择「Chat Completions（兼容接口）」。自定义模型采用文本输入，思考使用服务默认；没有发送思考参数不代表服务端关闭思考。

「上下文长度（tokens）」可设置当前模型的本地上下文预算，提供 128K、256K、512K、1M 快捷选项（十进制，1K = 1,000、1M = 1,000,000 tokens），也可手动填写精确整数。目录返回有效 `contextWindow` 时自动带入并保留原始数值；未提供或返回 `null` 时保持未知，自定义模型暂用 128,000 tokens 兜底，并在对话模型选择器标为「预算 128K」，不代表真实模型上限。可根据服务商文档填写准确数值，保存后界面与后端压缩使用同一预算，按服务地址和模型分别保留；更换 URL 不继承旧地址的配置。清空该字段并保存可恢复默认。已完成对话的用量环保留当时运行的预算，新设置不会改写历史记录。

模型列表通过本机后端按供应商协议获取，支持 OpenAI 兼容接口、Anthropic 和 Gemini；可点击 Model 右侧刷新按钮重试。获取列表不会保存配置或自动启用所有模型，只有点击「保存配置」才会保存选中的 Model ID。接口不支持列表、认证失败或网络超时时仍可手动填写。打开已有连接会使用已保存的密钥获取列表；若修改了 URL，必须填写该地址的 Key 才会再次获取，避免自动向新地址发送原密钥。

再次编辑时不会显示原密钥，API Key 留空会保留原有密钥。配置保存到 `<PANEL_DATA_DIR>/model-providers.json`（源码启动默认 `.panel/model-providers.json`），文件仅允许当前用户读写。界面保存的供应商配置优先于环境变量；未设置的供应商继续使用原有环境配置。密钥不写入浏览器存储，也不包含在探索导出中。

## 使用环境变量配置

也可复制 [.env.example](../.env.example) 为 `.env`，填写所需供应商，再重启服务：

```dotenv
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
```

无需填写全部供应商。内置模型目录与支持的思考等级取自 Pi。界面左下角「模型连接」显示配置状态，对话输入框下方可以单独选择执行模型与思考强度。加载 `.env` 时，已有的进程环境变量优先。

也支持 Paperbypass 网关。在 `.env` 中配置后重启，Luna Pro 和 `Atria-Dawn-Preview` 会出现在模型列表的 Paperbypass 分组中，共用同一个网关密钥：

```dotenv
PAPERBYPASS_API_KEY=你的密钥
PAPERBYPASS_BASE_URL=https://aigateway.paperbypass.com/api
PAPERBYPASS_MODEL=openai/gpt-5.6-luna-pro
PANEL_DEFAULT_MODEL=paperbypass/openai/gpt-5.6-luna-pro
```

网关通过 `Authorization: Bearer` 调用 `/api/v1/messages`，支持流式文本对话和工具调用。通过 Paperbypass 使用 Atria 只需 `PAPERBYPASS_API_KEY`，无需配置直连服务的 `ATRIA_API_KEY`；如需设为默认模型，将 `PANEL_DEFAULT_MODEL` 改为 `paperbypass/Atria-Dawn-Preview`。

Paperbypass 分组内置 `z-ai/glm-5.3-flash` 的图片输入支持，依据[智谱官方模型卡](https://huggingface.co/zai-org/GLM-5.3-Flash)，可接收图片附件和电脑控制截图。此前已作为自定义模型保存的同名型号会自动使用这项能力，保留已配置的上下文预算。此声明不扩展到 `z-ai/glm-5.3` 或其他未知型号，也不代表 Panel 已支持视频或音频输入。

`z-ai/glm-5.3` 和 `z-ai/glm-5.3-flash` 按[智谱官方说明](https://docs.z.ai/guides/capabilities/thinking)强制开启思考，提供 `low / high / max` 三个档位。默认及旧对话的 `off` 设置使用 `low`，通过网关的 `reasoning_effort` 传递；不发送该网关会拒绝的 Anthropic `thinking` 参数。自动审核独立选择 `low`，单次输出最多 8,192 tokens（包括思考和结论），上下文预算同步预留这部分空间；仍须在 60 秒内返回完整有效的审核 JSON。

Paperbypass 的 `anthropic/claude-opus-5.5` 按 [Claude 官方能力](https://platform.claude.com/docs/en/build-with-claude/effort)提供 `low / medium / high / xhigh / max`，通过 `output_config.effort` 传递。主对话分开显示思考开关和可选 effort，档位直接使用英文原名。未知能力显示「服务默认」，必须思考的模型锁定开启；支持开关的模型可在开启、关闭和默认之间选择。切换模型保留仍有效的 effort，否则恢复默认。自定义网关的默认 effort 不发送该字段；通过 effort 开关的模型在明确开启时使用首个已配置档位，原生模型沿用 SDK 的默认映射。操作审核独立优先使用 `low`（没有 low 的型号沿用首个可用档位）。

模型连接 → 配置供应商 → 选择 Model →「思考档位」可为新模型选择「自定义此模型」。独立配置开关方式（`thinking.type`、`effort = none`、必须开启或未知），以及 effort 格式与档位。格式支持顶层 `reasoning_effort`、嵌套 `reasoning.effort`、`output_config.effort` 和不发送；Responses 接口使用嵌套字段。仅支持开关的模型可以不配置 effort。设置按服务商、API URL 和 Model ID 保存，修改 API URL 会清除旧地址的手动能力设置。恢复「自动」会清除当前模型的覆盖。Google 分组沿用原生 SDK 能力，暂不提供自定义参数格式。

思考开关与 effort 独立选择，关闭思考后仍可调整 effort，切换开关不会覆盖所选档位。配置为 `thinking.type` 的接口分别发送开关和 effort，例如 `thinking.type=disabled` 与 `reasoning_effort=high`；参数是否接受及实际作用取决于该服务。原生适配器支持独立 effort 时保留其原有档位映射。若接口用 `effort=none` 关闭思考，或仅支持思考预算，无法同时表达关闭与独立强度，控件会提示冲突并在运行前报错；可将 effort 设为默认或开启思考。操作审核仍独立使用 low。

「检测思考选项」使用当前尚未保存的 URL、密钥、模型和所选接口，发送固定的简短算术提示，不包含历史对话或工具。一次点击最多调用 12 次（基线、开关、effort 和无效值对照），每次最多 256 输出 tokens、20 秒，整体最多两分钟，可停止；调用按服务商计费。更换地址必须重新填写密钥，变更草稿或关闭设置会取消检测。结果仅存在当前草稿中，不会自动保存。

检测只能确认请求接受或拒绝，不能证明不同 effort 的真实计算量不同。无效值也被接受时会提示网关可能忽略参数；只有无效值被拒绝的字段才可一键填入通过校验的选项。超时、认证失败、响应异常均显示未确认；未返回思考内容不代表思考关闭。可以按官方文档手动调整后保存。Paperbypass 目录目前没有 effort 能力元数据，未知型号显示「服务默认」。未编辑思考设置时保存其他连接信息会保留原配置。

`PANEL_DEFAULT_MODEL` 决定从探索起点发起对话时的默认模型；历史对话仍继承各自的模型设置。`PAPERBYPASS_MODEL` 可替换默认的 Luna Pro 模型 ID，Atria 选项始终保留。其他网关型号不发送额外思考参数，Atria 采用其[官方文档](https://api.atria-asi.ai/docs)中的 256,000 上下文窗口，其余模型采用 128,000 的本地上下文预算，不提供网关费用估算。

支持 API Key 配置及 Anthropic token 环境变量；不会读取 Pi CLI 的 OAuth 登录状态。模型密钥只在服务端使用，不保存在浏览器或导出文件中。

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

三款模型的上下文窗口为 1,048,576 tokens；Panel 的本地单次输出预算为 16,384 tokens。v2.6 Pro / Flash 支持图片输入，v2.5 Pro 在 Panel 中使用文本输入。MiMo 的独立思考开关发送 `thinking.type = enabled / disabled`，默认时不发送；没有已确认的独立 effort 档位，因此 effort 保持默认。旧的 off / high 配置分别迁移为关闭 / 开启。工具调用后的历史保留 `reasoning_content`。Token Plan 不显示单次费用估算。

搜索服务的可选配置见[网页搜索与网页、PDF 读取](TOOLS.md#网页搜索与网页pdf-读取)。
