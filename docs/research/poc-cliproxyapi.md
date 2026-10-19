# CLIProxyAPI：开发阶段 Pi 模型入口研究

查验日期：2026-10-19。研究票：[CLIProxyAPI 如何支撑开发阶段的 Pi 模型调用？](https://github.com/GordonFP/bau-support-agent/issues/13)。

**结论：可继续 Mock／合成样本开发，保留 Pi 1.3.0 SDK；实际模型联调仍有部署、协议与预算前置。** CPA 提供 Pi 已实现的两种 OpenAI 风格入口，不需要新增 Agent Framework。入口存在不代表选定模型的工具闭环、取消、计费和上限已经可用。尤其 Codex 路由会删除输出 token 上限；本研究没有找到足以证明“选定模型工具协议 + 4k 输出硬上限 + 可核算费用”同时满足的实际部署证据。

本次只读公开官方资料和固定源码，未安装或启动 CPA／Pi、读取真实凭据、调用模型或生产工具。用户确认的开发例外仅允许 Mock／合成样本；真实试点仍须公司网关契约、数据政策及适用访问批准。原政策与预算以[模型、数据与成本政策及开发阶段修订](https://github.com/GordonFP/bau-support-agent/issues/7)为准。

## 已确认事实：版本与证据

| 项目 | 固定基线与边界 |
| --- | --- |
| 官方项目 | `router-for-me/CLIProxyAPI`；README 指向官方文档 `help.router-for.me`。不把相似名称的 fork、Plus、Home 或桌面管理器当同一发行物。[README][readme] |
| 当前稳定发布 | GitHub latest 为 **v8.0.33**，`draft=false`、`prerelease=false`，发布于 `2026-10-18T13:06:35Z`；tag 源码为 **`2422c6b0f5fe16495320fa29456493874c1977a0`**。[发布页][release] |
| 许可证 | 固定源码顶层 MIT，须保留版权与许可文本，含无担保条款；未检查完整传递依赖、构建供应链或上游账户条款。[LICENSE][license] |
| 文档漂移 | v8 模板已使用 `server`、`access`、`management`、`observability` 等分组；兼容旧配置但 v8 字段优先。Context7 查到的部分官方说明仍含 v6 模块路径、旧配置和不同默认值，本记录以固定 v8 源码为准。[配置模板][config] |
| Pi 基线 | 复用[Pi SDK 研究固定记录][pi-study]：1.3.0，源码 `71023aec1546d6d677a65669c5665c0927ce0dd0`。本次只补查 Provider 配置及相关 API，不重做 MCP／会话研究。 |

这是上游发行基线，**不是用户已部署版本**；实际二进制／容器版本、镜像 digest、配置和所选上游均未提供。本次未下载或验证发行二进制，也未验证二进制与源码可复现一致。

## 已确认事实：Pi 接法及协议转换

CPA 固定路由注册 `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`，均经过客户端鉴权 middleware。[路由][routes]

| Pi 1.3.0 API | CPA 入口 | 能规划的范围与限制 |
| --- | --- | --- |
| `openai-completions` | `/v1/chat/completions` | Pi 发 messages／function tools，接收流式 tool call 参数，使用 `tool_call_id` 回传结果，并请求 `stream_options.include_usage=true`。CPA 的 Codex translator 有 tools、tool calls、结果和 token 字段转换实现；仍须选定模型验证。[Pi 实现][pi-chat]、[Codex 请求转换][codex-chat-request]、[响应转换][codex-chat-response] |
| `openai-responses` | `/v1/responses` | Pi 原有实现使用 function call／`call_id`／`function_call_output`，并携带 reasoning 项；CPA 有 Responses handler 和相应 translator。此入口不保证最终上游原生使用 Responses。[Pi 研究][pi-study]、[Responses handler][responses-handler] |

**两条上游路径必须区分：**

- **Codex 路径**：Responses translator 强制 `stream=true`、`store=false`、`parallel_tool_calls=true`，删除 `max_output_tokens`、`max_completion_tokens`、`temperature`、`top_p`，还会调整 system role、include 等字段。因此 Pi 发出的 4k 输出参数在这条路径上不能充当硬上限；本地收到 4k 后 Abort 也不能证明上游生成或计费已停止。[固定转换实现][codex-responses-request]
- **配置的 OpenAI compatibility 路径**：普通推理执行器实际发向上游 `/chat/completions`，包括客户端从 `/responses` 进入的情况。Responses 的 `max_output_tokens` 会转为 `max_tokens`，再按模型的 `use-max-completion-tokens` 归一化；该路径保留数值限制的代码依据存在，但上游是否执行、工具／reasoning 语义是否满足仍待证实。它不是原生 Responses 透传，也不是已选路线。[执行器][compat-executor]、[Responses 转 Chat][compat-converter]、[上限字段归一化][compat-limit]

原政策名称 `gpt6.1-sol` 不能推定为 CPA 可用 ID。既有 Pi 研究记录了该模型家族工具调用的 Responses 要求，因此不能因为通用 compatibility 路径保留了 token 数字，就认为它满足所选模型的工具契约。实际别名／上游／API 和硬上限须一起确认；不自动改模型、换 Provider 或绕过 CPA 直连。

工具执行仍由本服务 Pi 的受控工具 Adapter 完成。CPA 只转模型协议，不取得 MCP／业务资源授权。对参数 JSON、工具名称、结果 ID、并行调用、空参数、失败结果、reasoning 重放和最终证据引用逐项验收；转换会重写字段和格式，不能将“字节原样保留”作为默认假设。schema strict 也不能替代服务端校验与授权。

## 开发规格可采用的输入契约（建议，未配置）

1. 保留进程内 `createAgentSession()` 与既有隔离边界。在宿主持有的 `ModelRuntime` 上注册一个固定 Provider／模型配置；Pi `registerProvider()` 支持已知 API，不必安装自定义协议插件。官方 `models.json` 也可配置兼容 endpoint，但服务器应使用审核的显式配置，避免自动发现、动态模型刷新和 `!command` 取密钥。[Pi Provider][pi-provider]、[ModelRuntime][pi-runtime]、[模型配置][pi-models]
2. 端点仅作为本地说明占位：`http://127.0.0.1:8317/v1`；应用通过受控 `CPA_BASE_URL` 配置，禁止用户／模型输入覆盖 endpoint。它不是发现到的实际部署地址；跨容器或远程访问需另确认网络、TLS 与出口规则。
3. `CPA_API_KEY` 是 **CPA 客户端 key**，通过宿主 Secret 受控注入，映射到 Pi 的 runtime 凭据或已审核的 `$CPA_API_KEY` 环境引用，使用 `Authorization: Bearer …`；禁止放 URL query、提示词、模型历史或公开配置。上游账户凭据／OAuth token 止于 CPA 的受控凭据存储，与客户端 key、管理 key 分开。[客户端鉴权][access-provider]、[Pi 凭据配置][pi-models]
4. 明确配置 `providerId`、`api`、`modelId`、确认后的上游映射、text／reasoning 能力、contextWindow、maxTokens 与费率证据。`CPA_MODEL_ID` 只能来自实际部署核验后的允许列表；未知字段不可用任意模型 catalog 或 0 费率凑齐。注册会令模型“可选”，不等于做过网络可用性检查。[Pi Model 类型][pi-types]、[运行时注册][pi-runtime]
5. 应用统一管理绝对 deadline、次数、并发、速率和预算；Provider 层 `maxRetries=0`，禁用 Pi 不需要的自动重试／压缩／缓存预热。CPA 配置候选是 `routing.retry.request-retry=0`、`max-retry-credentials=1`、`max-retry-interval=0`、`requests.streaming.bootstrap-retries=0`，核对每个 Provider／credential 覆盖值，固定一个获准映射，禁用别名模型池与额外上游回退。**`request-retry=0` 只关闭额外轮次，初始轮仍可尝试多个凭据**；必须运行证明一次应用调用对应的实际上游尝试数。[v8 重试与别名注释][config]、[Pi 请求选项][pi-types]

以上是配置输入与测试边界，不是可直接上线的完整配置；本次没有创建含凭据或真实模型 ID 的文件。

## 已确认事实：流式、取消与错误

- Pi Chat 实现将 AbortSignal／timeout 传给客户端，并把失败、取消表示为 `error`／`aborted`。CPA 以请求 context 联动上游 HTTP context，Responses 流式路径在客户端断开或写失败时取消执行。这只证明代码有传播路径，不能证明实际代理层及时关闭连接，或撤销已完成的生成／收费。[Pi 请求实现][pi-chat]、[CPA context][context]、[Responses handler][responses-handler]
- HTTP 状态成功后仍可能出现 SSE `error`／`response.failed`；固定版还处理没有终止事件的截断流。应用必须等待协议终止及 Pi settled 状态，部分文本／部分工具参数不可执行成完整调用、也不可当完整诊断。[Responses handler][responses-handler]、[流式错误分类][stream-errors]、[Pi 研究][pi-study]
- v8 模板将额外 credential retry rounds 配为 3，最大凭据数 0 表示尝试全部；bootstrap retry 是另一个开关。HTTP／SSE 分类和转换可能改变重试观测面；不能把单个下游响应的 usage 当所有上游尝试总和。应用仅对获准临时网络失败最多重试一次，计入总次数、费用和整次时限；权限／契约错误不重试。[配置][config]
- CPA 上游 HTTP client 与监听代码并未给本任务自动提供 60 秒／180 秒整体时限；keepalive、TLS handshake timeout、cooldown wait 也不是整次 deadline。完整输入须在发出前计算／限制，防止 CPA 注入／重写造成上下游 token 口径偏差；无法证明符合上限时拒绝实际调用。

## 已确认事实：usage 不是结算或硬预算

| 证据 | 对本 POC 的含义 |
| --- | --- |
| Codex 转 Chat 可映射 input／output／cached／reasoning token；Responses helper 会为缺失的 cache／reasoning 明细补 0。[转换][codex-chat-response]、[补值实现][usage-details] | 下游 0 可能是转换默认值，不能证明真实消耗为零；应保留 usage 来源、缺失／补值状态与实际尝试关联。 |
| CPA usage record 含 Provider、Alias、Model、ResponseModel、TraceID、每次 execution RequestID、失败和 token 明细；`Detail` 没有货币结算字段。[记录结构][usage-record] | CPA token 遥测不等于供应商账单。该结构还包含 APIKey、BaseURL、SessionID 和失败正文等敏感信息，不能原样提交 Git 或接入业务审计。 |
| `EnsurePublished` 在上游完全没给 token 时也会发布空 `Detail`；token breakdown 有 complete／inconsistent／unclassified 分类。[空值发布][usage-reporter]、[会计结构][usage-accounting] | 请求计数可存在而 token 未知；空／0／complete 的局部分类均不证明账单完整，不能据此放行下一次费用预留。 |
| v8 `usage-statistics-enabled=false` 描述的是关闭内存聚合，模板还列出管理 usage queue 的保留期；Pi 根据模型配置费率计算 `usage.cost`。[配置][config]、[Pi 计算][pi-chat] | 开关不是硬配额，也不证明所有遥测副本都关闭；Pi cost 是本地估算，不是 CPA 返回的实际结算。费用缺失／订阅账户不能推定免费。 |

**原约束全部保留**：POC US$100、单请求 US$2、完整输入 24k tokens、输出 4k、每请求 6 次模型调用、单调用 60 秒、整次 180 秒、全局并发 2、每分钟启动 6 次，临时网络失败最多重试一次且计入限额。[已确认政策](https://github.com/GordonFP/bau-support-agent/issues/7#issuecomment-6262720794)

实际联调前须提供可执行的费率／结算口径、未知用量和失败／重试计费规则，以及保守费用预留与全局原子累计的方案。仅有客户端统计、收流后截断或 CPA 使用量面板不足以证明硬预算；若无法证明输出／费用上限，继续 Mock，不能放宽已批准上限。这里没有批准新的费率或测试预算。

## 最低接入约束与部署未知

| 静态事实 | 本任务最低约束／待确认 |
| --- | --- |
| v8 `server.host` 默认空表示监听所有接口；TLS、mDNS discovery、pprof、动态插件默认关闭。[配置][config] | 本地开发显式 loopback，Docker 映射也限制宿主 loopback；远程部署使用获准的隔离网络／TLS。显式保持 discovery、pprof、plugins 关闭；CPA 容器只可访问批准上游，不给业务资源凭据。 |
| 客户端 key 未配置时原生 access provider 注销；access manager 无 provider 会返回无错误，middleware 继续。模板样例 key 的 safe mode 是另一层机制。[provider][access-provider]、[manager][access-manager]、[middleware][auth-middleware] | 禁止空 key／示例 key，启动前做配置检查；运行验证缺失／错误 key 均拒绝。共享 CPA key 不是业务用户授权，用户隔离仍由本服务负责。 |
| 管理 secret 为空通常不注册管理 API，但 `MANAGEMENT_PASSWORD` 或 TUI local password 也可启用；面板是独立配置。[server][server] | 显式关闭远程管理／控制面板，检查环境和启动参数；若必须管理，使用分离 key、网络及运维路径，不向 Pi／模型暴露管理工具。 |
| `request-log=false` 仍有仅错误记录；大／未知长度请求可以先 spool 到磁盘，失败后保留。`logging-to-file=false` 只是应用日志输出位置；`error-logs-max-files=0` 是关闭清理。[middleware][request-log]、[格式][request-format]、[配置][config] | 假设请求／响应／错误／临时文件可能落盘，只允许合成数据；限制并保护日志／auth 目录、明确保留和删除。不能宣称这些开关提供零保留或自动脱敏。 |

CPA 的 `store=false`、本地部署和 MIT 许可证都不确定上游驻留、保留、训练、账户使用权或组织批准。必须确认实际账户及上游条款；真实内部日志／代码不在本次授权范围。

## 后续最小验证（本次均未执行）

1. **部署契约**：确认实际版本／digest、受控 endpoint 与 key 注入位置、唯一模型别名／上游、账户授权、API、schema、reasoning、完整 token／费率口径。脱敏记录这些事实；缺失模型映射或预算保证时不发模型请求。
2. **先做 Mock wire 测试**：精确 Pi 1.3.0，在受控本地假服务验证两种候选入口的请求路径、Bearer、文本、分块参数、工具 ID／结果／reasoning 往返和最终证据引用。确认无任意 extension、工具或框架被额外加载。
3. **失败与并发**：合成 401／403／404、429／5xx、无效 JSON、SSE 内错误、截断流、迟到响应、无 usage、取消前／中／后和代理断连；未完成报告带原因。60 秒／180 秒终止，A 取消不影响 B，实际尝试次数和重试计入预算。
4. **限额与费用**：检查 CPA 最终上游 payload 的 token 字段、模型替换和注入；测试上限请求、缺失 usage、收费失败及多尝试，验证 24k／4k、6 次、并发／速率和原子预算预留。未知费用默认阻断，不能用 Pi 0 cost 测试通过替代真实计费证据。
5. **网络／落盘**：验证绑定范围、错误／缺失 key 拒绝、管理 API／面板／pprof／发现关闭；用合成敏感标记扫描应用与 CPA 日志、错误日志、临时文件、会话、缓存及审计。验证凭据不泄露、目录隔离与到期删除。
6. **获准模型闭环**：前置契约和预算控制满足后，才对明确选定模型发合成样本，完成 prompt → tool call → 安全结果 → final answer，核对流式终止、usage 与结算。两种 API 不做自动回退；版本／路由变化重跑受影响项。

## 本次验证记录

已执行：完整读取研究票及引用的政策／Pi 固定研究；Context7 resolve 后查询官方项目与文档；GitHub release 元数据核对；浅克隆 v8.0.33 并确认 HEAD 为上述固定 Commit；固定源码静态路径核对；研究 Markdown 结构、引用目标／行号与固定 Commit 一致性检查；`git diff --check`。

未执行：依赖安装、发行二进制校验、服务启动、模型／生产调用、自动化运行测试、类型检查、构建、完整安全／许可证扫描。静态研究关闭不代表上述运行门槛通过。

[readme]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/README.md
[release]: https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.33
[license]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/LICENSE
[config]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/config.example.yaml
[routes]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/internal/api/server_routes.go#L63-L88
[codex-chat-request]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/internal/translator/codex/openai/chat-completions/codex_openai_request.go
[codex-chat-response]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/internal/translator/codex/openai/chat-completions/codex_openai_response.go
[codex-responses-request]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/internal/translator/codex/openai/responses/codex_openai-responses_request.go#L15-L62
[compat-executor]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/internal/runtime/executor/openai_compat_executor.go#L104-L158
[compat-converter]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/internal/translator/openai/openai/responses/openai_openai-responses_request.go#L28-L73
[compat-limit]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/internal/runtime/executor/helps/openai_compat_max_tokens.go
[responses-handler]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/sdk/api/handlers/openai/openai_responses_handlers.go
[context]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/sdk/api/handlers/handlers.go#L552-L634
[stream-errors]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/sdk/api/handlers/openai_responses_stream_error.go
[usage-details]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/internal/runtime/executor/helps/responses_usage_helpers.go
[usage-record]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/sdk/cliproxy/usage/manager.go#L26-L94
[usage-reporter]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/internal/runtime/executor/helps/usage_helpers.go#L560-L587
[usage-accounting]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/sdk/cliproxy/usage/accounting.go
[access-provider]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/internal/access/config_access/provider.go
[access-manager]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/sdk/access/manager.go#L51-L63
[auth-middleware]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/internal/api/server_middleware.go#L100-L126
[server]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/internal/api/server.go#L248-L267
[request-log]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/internal/api/middleware/request_logging.go#L25-L137
[request-format]: https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/internal/logging/request_logger_format.go
[pi-study]: https://github.com/GordonFP/bau-support-agent/blob/090f7ef8d96a604f7ec1bd5d41b4e8d807bca422/docs/research/poc-pi-sdk.md
[pi-provider]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/docs/custom-provider.md#L1-L30
[pi-runtime]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/model-runtime.ts#L928-L948
[pi-models]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/docs/models.md#L45-L73
[pi-types]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/types.ts
[pi-chat]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/api/openai-completions.ts
