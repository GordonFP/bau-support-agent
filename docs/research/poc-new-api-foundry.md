# New API → Azure Foundry：公司模型网关公开资料补充

查验日期：2026-10-20。关联任务：[提供公司模型网关的脱敏契约与政策确认记录](https://github.com/GordonFP/bau-support-agent/issues/12)。

**公开资料可以补齐通用协议、配置项及厂商政策的适用条件，不能补成公司的实际部署契约或批准记录。** 用户确认了“通过 New API 接入 Azure Foundry”；本次没有访问公司网关、使用凭据、调用模型或读取生产资料。示例地址与 key 不写入本记录。原模型策略、预算及 Mock／合成样本开发范围继续有效。

## 固定证据基线

| 项目 | 已查明事实与边界 |
| --- | --- |
| 官方项目 | `QuantumNous/new-api`；官方仓库 README 指向 `docs.newapi.ai`／`docs.newapi.pro` 文档。下文仅使用该仓库、其官方文档与 Microsoft 官方资料。[README][newapi-readme] |
| 查验时 latest | GitHub release API 返回 **v1.0.0-rc.45**，发布时间 **2026-10-17T15:42:41Z**，`draft=false`、`prerelease=false`。名称及发行说明仍明确是 release candidate，不将 API 的 `prerelease=false` 解释为 GA。[发布页][newapi-release]、[发布 API][newapi-release-api] |
| 固定源码 | tag 指向 **`6cf0d90b5ff27f901697dddd61e0c28aba8efefc`**，commit 时间 **2026-10-17T15:24:33Z**；已浅克隆并切到该 commit。[commit][newapi-commit] |
| 许可证 | 固定源码顶层为 GNU AGPL v3；本研究未评估依赖或组织的具体许可义务。[LICENSE][newapi-license] |
| 部署未知 | 上述是上游研究基线，**不是公司的已部署版本**。实际版本／镜像 digest、渠道类型、映射、参数覆盖、日志与计费配置均未提供。在线文档可以更新，默认行为以下列固定源码为准。 |

## New API 客户端协议

用户示例与官方 New API 客户端形状一致：JSON `POST /v1/chat/completions`，`Authorization: Bearer <gateway-client-key>`，必填 `model` 与 `messages`。客户端 key 是 New API 的令牌；上游 Azure key 是另一份由网关持有的渠道凭据，不能从客户端 Bearer 推定 Azure 认证方式。[Chat 文档][newapi-chat-doc]、[路由][newapi-routes]、[鉴权][newapi-auth]

| 场景 | 可写入 Mock／合成样本规格的通用契约 |
| --- | --- |
| 非流式文本 | `stream=false` 为文档默认；响应 `id`、`object=chat.completion`、`model`、`choices[].message`、`finish_reason` 与 `usage`。模型名称、内容和 usage 未必是原样上游字段。[Chat 文档][newapi-chat-doc]、[响应处理][newapi-response] |
| function tools | 请求包含 `tools`／`tool_choice`；assistant 返回 `tool_calls[].id`、`function.name` 及字符串 `function.arguments`，客户端以 `role=tool`、匹配的 `tool_call_id` 和结果回传，再调用模型。固定 DTO 有工具调用、结果 ID 和 reasoning 字段；这是网关的格式能力，仍需选定模型支持。[请求 DTO][newapi-request-dto]、[响应 DTO][newapi-response-dto] |
| 流式 | 请求 `stream=true`、`stream_options.include_usage=true`；读取 SSE 的 `choices[].delta`，跨 chunk 聚合工具参数及调用 ID，检查终止。固定实现读取 `data:`、识别 `[DONE]`，可能自己追加 usage chunk 和 `[DONE]`；只看到 `[DONE]` 不能证明得到的是未改写的上游成功终态。[扫描器][newapi-stream]、[最终事件][newapi-final] |
| 错误 | 通常是 HTTP 非 2xx 和 `error: {message,type,param,code}`。本地鉴权可给 401／403，调用失败／坏响应可给 5xx，上游错误会被转换，渠道还可配置 HTTP 状态映射。应用应联合 HTTP、error body、流完整性判断，不能只按某一个公开示例的状态码重试。[鉴权][newapi-auth]、[错误处理][newapi-error]、[Chat helper][newapi-chat-helper] |

网关不执行本服务的业务工具，也不能替代 Pi Adapter 的参数校验、授权与工具结果隔离。工具参数 JSON、并行调用、空参数、失败结果、reasoning 往返及最后的证据引用，仍属于获准联调时的验收项。既有 Pi 1.3.0 的 `openai-completions` 能承载上述 Chat 格式；API 风格一致不等于特定模型闭环已经通过。[Pi 研究](https://github.com/GordonFP/bau-support-agent/blob/090f7ef8d96a604f7ec1bd5d41b4e8d807bca422/docs/research/poc-pi-sdk.md)

## New API 的 Azure 路由与参数转换

**“接 Azure Foundry”还不足以选择一个 New API 渠道配置。** 固定版有 `Azure`（type 3）、`OpenAI`（type 1）和自定义渠道等，未见一个独立名为 Foundry 的渠道类型。应先确认实际 Azure endpoint／部署的 API 类型，再核对实际渠道；不从公司客户端 `/v1/chat/completions` 反推内部路径。[渠道类型][newapi-channel-types]

| 固定版路径 | 行为与实际部署仍需提供的证据 |
| --- | --- |
| Azure 渠道 Chat | 将映射后的上游名称放进 `/openai/deployments/{deployment}/chat/completions?api-version=…`，上游使用 `api-key`。未显式指定 API version 时默认 `2025-04-01-preview`。2025-05-10 前创建的旧渠道另有删除名称中 `.` 的兼容分支。[Azure adaptor][newapi-adaptor]、[默认值][newapi-init] |
| Azure 渠道 Responses | 另有 `/openai/v1/responses?api-version=preview` 分支；特定 `cognitiveservices.azure.com` host 改用 `/openai/responses` 和 Azure API version，渠道可覆盖 Responses version。不能将 Chat 的版本／路径套给 Responses。[Azure adaptor][newapi-adaptor] |
| OpenAI 兼容／自定义入口 | 普通 OpenAI 渠道通常把 Base URL 与客户端路径拼接，默认 Bearer；自定义渠道可把 `{model}` 放在 URL。Foundry 具体 endpoint 需要什么路径和认证，要与真实渠道设置匹配，不能只换域名。[URL 拼接][newapi-url]、[adaptor][newapi-adaptor] |
| Chat → Responses | 存在全局策略，可按渠道和模型 pattern 选择转换；固定版默认 **关闭**，且开启透传会跳过该路径。公开支持该转换不能证明公司开启或所有语义无损。[策略默认][newapi-global]、[调用路径][newapi-chat-helper] |

模型映射支持链式重定向并检查循环；公开客户端名称、计费模型名称和 Azure deployment 可以不同。配置还可以覆盖参数、插入消息、改模型或删除字段。因此需脱敏确认“客户端 alias → 唯一获准渠道 → 上游 deployment／模型及版本 → API”的映射，并核对最终发给上游的 payload。[模型映射][newapi-mapping]、[渠道文档][newapi-channel-doc]

- **输出上限**：固定 adaptor 对识别出的 o 系列、部分 GPT 家族把 `max_tokens` 转成 `max_completion_tokens`，条件是后者为空／0、前者非 0。能力判定以**映射后模型名**及 reasoning effort 为依据；未知模型保留参数，不会自动推断未来家族规则。任意 Azure deployment alias 未必触发模型规则；同时传两个字段也不会在该分支自动消除冲突。原定模型的获准 API 和实际最终 token 字段必须单独确认，不能用客户端的 4k 数字证明上游硬上限。[能力规则][newapi-capabilities]、[adaptor][newapi-adaptor]
- **sampling／reasoning**：能力规则可删除不支持的 `temperature`、`top_p`、logprobs，并把首个 system 转 developer；reasoning 还可能受模型尾缀、`@` modifier 和转换路径影响。网关实现 reasoning 字段不代表每个 Foundry 模型都支持。用户示例的 `temperature=0.7` 只能作为示例输入，不能冻结为所有模型的必传契约。[能力规则][newapi-capabilities]、[adaptor][newapi-adaptor]
- **过滤与覆盖顺序**：正常路径是模型映射、转换、删除禁用字段，再应用参数覆盖；全局或渠道 body 透传走另一分支。固定默认过滤 `service_tier`、`inference_geo`、`speed`、`safety_identifier`、`stream_options.include_obfuscation`，`store` 默认允许透传；`DisableStore` 只是删除该字段，**不是主动发送 `store=false`**。因此不能靠网关名称推断零存储、默认价格或最终输出上限。[Chat helper][newapi-chat-helper]、[过滤实现][newapi-filter]

Microsoft 公开目录可确认 **`DeepSeek-V4-Flash`** 条目；**公司客户端同名 alias 对应的 Azure 部署、版本和可用区域仍未知**。rc.45 内置资料含小写 `deepseek-flash`、`deepseek-v4-pro` 及旧 `deepseek-v4-flash` 价格 alias，但这是 New API 对 DeepSeek 上游的支持／价格默认值，不能证明示例 ID 是公司的实际 Azure deployment，更不能据此替换原定模型策略。[DeepSeek 列表][newapi-deepseek]、[内置价格][newapi-builtin-prices]

## 重试、超时、取消与预算

| 固定源码事实 | 对原冻结门槛的含义 |
| --- | --- |
| `RetryTimes=0`；relay loop 为初始尝试加配置的额外重试，失败策略可以按状态、channel 约束和会话亲和决定停止／换渠道。渠道优先级、权重、多 key 与分组均可配置。[常量][newapi-defaults]、[relay loop][newapi-relay-loop]、[重试决策][newapi-retry] | 不能推定公司仍是 0。应用和网关重试叠加会消耗多个上游尝试；需要固定允许路由并取得实际重试／故障切换配置和每次尝试的关联证据。 |
| `RELAY_TIMEOUT=0` 表示 HTTP client 无整体 timeout；响应头等待默认 1800 秒；`STREAMING_TIMEOUT=300` 在每次扫描一行时 reset，属于流闲置控制。[初始化][newapi-init]、[HTTP client][newapi-http]、[扫描器][newapi-stream] | 均不能提供本 POC 单调用 60 秒、每轮 180 秒的保证；宿主仍须单调时钟 deadline。补问等待停表、有效补充重置该轮时限；次数／费用按案累计，重试计入累计限额。 |
| OpenAI／Azure adaptor 的普通 HTTP 路径调用 `DoApiRequest`，以 `http.NewRequest` 建上游请求后直接 `relayClient.Do(req)`，该路径未把客户端 context 绑定上游请求；进入流 scanner 后才监听客户端断开并关闭上游 body。带 `NewRequestWithContext` 的 task helper 是另一条路径。[普通请求][newapi-request-context]、[HTTP 执行][newapi-request-do]、[扫描器][newapi-stream] | **不能证明首响应前或非流式请求取消会立即终止上游**；需检查实际部署版本及反向代理链。收到 SSE 后关闭 body 也不证明撤销已生成 token／收费。 |
| token 模式预扣基于预计**输入费用**乘倍率；默认倍率 1。钱包免预扣门槛默认 US$10，同时满足 token／钱包余额条件即可把预扣设为 0；订阅不走该旁路。[预扣计算][newapi-price]、[预扣配置][newapi-quota-config]、[结算会话][newapi-billing-session] | 不能把 New API 余额／预扣当作包含输出、隐藏推理、失败、取消及全部尝试的单请求硬预算。既有 US$2／US$100 控制仍需本服务的保守预留和原子累计。 |

未批准额外请求次数或费用；也未建议通过关闭既有上限来兼容网关。若实际 payload 无法证明输出硬上限或费用可核算，继续 Mock／合成样本开发。

## usage、价格与网关留存的公开边界

**客户端 `usage` 不保证是 Foundry 原始 usage，也不等于 Azure 账单。** 固定版 `FORCE_STREAM_OPTION=true`、`CountToken=true`；支持 stream options 时会向上游强制请求 usage，但上游能否提供仍受具体渠道／模型影响。[初始化][newapi-init]、[Chat helper][newapi-chat-helper]

- 流式缺少有效 usage 时，代码从累计响应文本估算 completion，加估算 prompt，并加工具调用修正值；末尾可发合成 usage chunk。非流式 `prompt_tokens==0` 时也会回填估算 prompt，必要时从内容／reasoning 计算 completion，然后改写响应 usage。缺少 hidden reasoning／缓存明细不能被本地文本计数补成真实账单。[响应处理][newapi-response]、[估算 helper][newapi-usage-estimate]、[最终事件][newapi-final]
- 计费可由模型倍率、completion／cache／分组倍率或表达式／按次价格决定；预扣与结算价格使用的名称也不一定是上游返回名称。默认价是上游软件的配置起点，管理员可修改；不能从 New API 内置的 DeepSeek 直连价格推导公司的 Azure 合同价。[价格选择][newapi-price]、[内置价格][newapi-builtin-prices]
- 固定版有 `usage_billing_path` 区分 local、upstream 和转换后的 estimated 口径，并记录请求及上游 request ID；这些是核验来源的线索，不是对 Azure 账单完整性的保证。实际需要脱敏费率生效日期／币种、输入／输出／缓存／reasoning 口径、失败／取消／重试收费规则和对账方式。[usage 来源][newapi-usage-path]、[usage log][newapi-log]
- `LogConsumeEnabled=true`；消费日志可记用户／token 名、模型、channel、token 数、quota、时长、请求及上游 ID，用户设置控制是否记 IP。`ERROR_LOG_ENABLED=false` 是错误日志表开关，不等于关闭应用日志；debug 模式可输出请求体、上游响应及每个 SSE 行。公开字段／开关不能替代公司日志配置、访问控制和删除记录。[默认值][newapi-defaults]、[初始化][newapi-init]、[日志写入][newapi-log]、[debug 路径][newapi-chat-helper]
- `log_setting.max_range_days=365` 限制查询／导出时间范围，**不是日志自动删除 TTL**；存在按截止时间批量删除接口，但不能从有接口推定运维执行了删除。反向代理、APM、数据库备份、审计和本服务会话的副本也不由这个参数说明。[查询范围][newapi-log-setting]、[删除实现][newapi-log-delete]

## Azure Foundry：接口、模型与数据政策

### 接口路线与模型能力

Foundry 的下游产品名不能唯一确定上游 API。官方 v1 支持 `https://<resource>.openai.azure.com/openai/v1/` 和 `https://<resource>.services.ai.azure.com/openai/v1/`，GA 调用不再要求日期式 `api-version`，兼容支持该协议的 DeepSeek 等模型；当前官方也说明 Azure sold DeepSeek 等可使用 Responses。`model` 在部署型示例中填写实际 deployment 名，而不是自动等于公开目录 ID。[v1 生命周期文档][azure-v1]

需区分 Azure 日期版的 `/openai/deployments/<deployment>/chat/completions?api-version=<date>`、OpenAI v1，以及旧 `/models/chat/completions`。官方已要求新集成采用 OpenAI v1，而非旧 `/models`；Azure AI Inference beta SDK 于 2026-08-26 退役不等于所有旧 REST 请求已停服。New API 固定版仍有自己的日期版适配，故必须核实实际渠道与协议，不能把下游 `/v1` 当作上游版本证明。[日期版参考][azure-dated]、[集成与迁移][azure-integrate]

| 模型资料 | 能确定什么 | 不能替代什么 |
| --- | --- | --- |
| `DeepSeek-V4-Flash` | 官方 Azure sold 目录有此条目，列 Chat Completion（with reasoning content）、tool calling Yes、Text/JSON。[模型能力表][azure-models] | 公司网关同名 alias 的实际目标、Flash 版本、渠道允许参数及完整工具往返验证；Text/JSON 不自动等于 strict JSON Schema |
| Flash 生命周期 | 官方表列版本 `2026-04-23`、GA、退役日期 `2028-02-20`；`DeepSeek-V4-Flash-0731` 是另一 Preview 条目，不自动替换原版。[退役表][azure-retirement] | 实际部署的版本和升级策略；日期与未来状态须在启用前重新核对 |
| 原定 `gpt6.1-sol` | 公开模型写作 `gpt-6.1-sol`；官方虽列 Chat 文本，但 Functions/tools/parallel tool calling 明确标注 **Responses API only**。[模型能力表][azure-models] | 两种名称的映射、是否继续使用原模型以及 New API 的 Responses 支持；不能用 Flash 的 Chat 示例证明原模型工具可用 |

本轮用户确认的是 New API → Foundry 路线；没有明确更换已选模型。本记录不修改模型政策，也不从示例自动改用 DeepSeek。若保留原模型，须按其实际映射和 Responses 工具契约验证；若将来改选模型，另记录人工决策。

### 可补齐的响应、工具与失败语义

Microsoft v1 Chat 参考与前述网关格式可共同作为**合成协议测试输入**：响应有 `choices[].message`、`finish_reason`、`usage`；工具结果使用 `role=tool` 和匹配的 `tool_call_id`；参数字符串及 SSE `delta` 要完整拼装后才能执行。`stream_options.include_usage=true` 请求结束前的 usage chunk，断流可能收不到；`max_completion_tokens` 的定义包含可见输出和 reasoning tokens，`max_tokens` 已弃用且有模型限制。可选 `reasoning_content` 不保证所有模型返回。[v1 Chat REST][azure-chat]

具体模型对 token 参数、sampling、reasoning 和工具支持仍以模型资料及实际通道为准。微软的非 OpenAI reasoning 指南不能被概括成每个 Flash 参数都已通过；例如指南用 V4-Pro 演示的设置不自动适用于 Flash。[推理指南][azure-reasoning]

HTTP 401/404/429 等提供诊断线索，但 New API 可转换错误、状态与 headers；应用还须处理 `content_filter`、`length`、截断 SSE、无最终 usage、部分工具参数和迟到结果。授权或契约错误不重试，临时网络失败遵循已有最多一次重试政策；若 429 等待超出当前轮剩余时间则结束，不为了 SDK 的一般退避建议延长已冻结的时限。[集成故障说明][azure-integrate]、[配额说明][azure-quota]

### 数据处理与驻留：适用条件

Azure sold 与 partner/community 是不同销售类别。前者由 Azure 托管、通过 Azure 订阅计费；后者可能适用供应商经 Marketplace 提供的条款。公开目录列有 Azure sold Flash，不代表公司所选渠道必然指向该类别。[模型能力表][azure-models]、[合作伙伴模型][azure-partners]

对于**已证实属于 Azure sold** 的实际模型，微软承诺提示和输出不提供给原模型供应商，未经许可／指令不用于训练基础生成模型或改善 Microsoft／第三方产品。该承诺不能解释成全链路零保留：Responses history、Files、Threads、Stored completions 等可持久保存内容；Preview 可能有不同实践。[Azure sold 隐私说明][azure-privacy]

滥用监测可对被标记样本进行自动复核，必要时涉及存储和授权 Microsoft 员工人审；modified abuse monitoring 需要额外申请批准，获批后仍可能自动复核。当前查阅的英文政策没有给出适用于所有部署的统一保留天数，本记录不填造“30 天”或把公司尚未证明的状态写作已关闭。[Abuse monitoring][azure-abuse]、[适用产品条款][azure-terms]

Serverless 部署的处理位置由 SKU 决定：Global 可跨相关全球区域；DataZone 限微软定义的 US/EU/APAC zone；Standard／Regional Provisioned 限指定 Azure geography，仍可能在 geography 内跨 region。静态存储 geography 与推理处理位置须分列，不是每个模型都支持全部类型。网关域名、用户地点及 resource region 不足以单独证明处理范围。[部署类型][azure-deployments]

这些是厂商条件性承诺，不能覆盖 New API、反向代理、APM、数据库备份或本服务的日志与记录；实际保留／删除、访问权和发送真实脱敏日志／代码的公司确认仍须单独记录。

### Azure 计费与硬预算

公开 DeepSeek 价格页列 Flash 的输入、缓存输入及输出每百万 token 计价栏，本次静态读取金额为动态占位，不能据此填造单价。实际需对应 Azure 合同／offer、生效日期、部署类型、币种与 New API 计价配置；New API 内置 DeepSeek 价格不能代替 Azure 费率。[官方 DeepSeek 价格页][azure-pricing]

微软说明 HTTP 状态本身不能决定收费，是否执行了可计费处理及 meter 规则才是依据，实际账单／meter 用于对账。客户端超时、Abort、断流与网关本地退款都不能推出 Azure 已停止处理或零收费。[成本与账单][azure-cost]、[延迟与流式][azure-latency]

Azure Cost Management budget 是告警，消费不会因此停止，使用量还有汇总延迟，不能承担本 POC 的 US$2／US$100 硬闸。设计上继续采用已冻结的调用前保守预留、原子累计和未知费用保留；重试、取消、部分结果及 reasoning 均须纳入实际计费口径。[Azure budgets][azure-budgets]

## 仍需部署方提供的最小证据

公开资料已可作为通用协议与政策输入，以下事项只在进入对应真实步骤前补齐，不阻塞现有 Mock／合成规格。

| 项目 | 需要的脱敏事实 | 用途 |
| --- | --- | --- |
| 部署基线 | New API 实际版本／digest、Azure 渠道类型、API 版本；模型别名到上游模型及部署版本的映射 | 决定使用 Chat Completions 还是 Responses，固定可复现协议；不自动修改既有模型选择 |
| 预算执行 | 最终 token 参数、重试／路由策略、网关计价配置、Azure 实际计费来源和口径 | 保留 24k 输入、4k 输出、单案 US$2／POC US$100 等原限制，未知用量不能按零结算 |
| 数据处理 | Azure 销售方式、部署类型与地域、滥用监测状态，以及网关／代理的正文日志、缓存、备份与保留／删除配置 | 确定实际数据路径，避免把公开产品承诺泛化为所有中间层的零保留 |
| 公司确认 | 允许发送真实脱敏日志／代码的确认状态、责任角色、日期和受控证据代号；适用资源访问批准 | 资料齐备、组织批准与运行验证分别记录 |

本轮只检索公开资料、形成静态研究并维护 tracker；未连接公司网关或租户、读取或配置凭据、发起模型调用，未进行实际安装版本、协议、计费、权限或部署运行验证。对应真实路径继续受现有门槛约束。

## 后续分阶段验证输入（本轮未执行）

以下沿用[POC 最小实施规格](https://github.com/GordonFP/bau-support-agent/issues/10#issuecomment-6283277463)的四组测试接口和 G0–G4 门槛，不新增接口、不批准真实调用。

1. 本地合成协议服务先验证 Pi → 网关候选协议 → 合成上游：文本、工具调用／结果 ID、分块 JSON、reasoning、最终报告引用；Chat 和 Responses 分别测试，不自动回退。
2. 核对最终上游 payload 的模型、API、token 字段和参数覆盖；完整输入 24k、总生成输出 4k（含适用 reasoning）须有实际执行点，不能以只裁剪可见文本代替。重试、隐藏调用、并发与每案累计次数／费用共同计入原预算。
3. 分别验证首响应前、非流式读响应、SSE 中途断开，以及超时／迟到结果；不能凭宿主 Abort 提前释放仍未知的上游并发或费用预留。每轮 180 秒及单调用 60 秒均按既有计时修订执行。
4. 注入缺 usage、估算 usage、截断流、content_filter、参数／鉴权错误与临时网络失败；记录来源、每次尝试、预留与结算状态。未知费用不按零，权限／契约错误不重试，整体不能越过当前轮 deadline。
5. 用合成敏感标记检查模型、本服务与网关输出、错误、debug、持久日志和备份范围；核验网关参数与实际日志／删除配置。只在相应资料、公司批准及测试授权齐备后验证实际 Azure 通道、计费对账和真实数据路径。

## 文档时效与本次验证记录

Microsoft 页面是动态官方资料，本轮访问日期为 2026-10-20；可见更新时间包括模型目录 2026-10-08、退役表 2026-09-23、v1 Chat 参考 2026-06-11、数据政策／abuse monitoring 2026-05-19、部署类型 2026-08-12，以及集成迁移说明 2026-08-27。新版本或实际接入前重新核对，不把这些页面日期当作公司确认日期。

已执行：读取研究 Skill、当前资料票、相关政策与既有研究记录；两个研究 agent 分别核对 New API 与 Microsoft 官方资料，并经主 agent 合成；Context7 均先 resolve 再查询官方文档／样例；web 浏览及交叉核对官方文档；GitHub 公开 release／tag／commit 元数据核对；浅克隆 tag 并确认固定 SHA；静态核对协议、路由、参数转换、usage、重试、取消、预扣及日志配置路径；Markdown 引用定义、固定源码文件／行号、脱敏与格式检查。

未执行：依赖安装、服务启动、实际部署／镜像验证、任何模型或公司生产 endpoint 调用、自动化行为测试、类型检查、构建和完整许可证／安全扫描。本记录是公开研究，不构成实际联调完成。

[newapi-readme]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/README.md
[newapi-release]: https://github.com/QuantumNous/new-api/releases/tag/v1.0.0-rc.45
[newapi-release-api]: https://api.github.com/repos/QuantumNous/new-api/releases/tags/v1.0.0-rc.45
[newapi-commit]: https://github.com/QuantumNous/new-api/commit/6cf0d90b5ff27f901697dddd61e0c28aba8efefc
[newapi-license]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/LICENSE
[newapi-chat-doc]: https://docs.newapi.pro/zh/docs/api/ai-model/chat/openai/createchatcompletion
[newapi-routes]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/router/relay-router.go#L73-L107
[newapi-auth]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/middleware/auth.go#L528-L637
[newapi-request-dto]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/relaykit/dto/openai_request.go#L434-L479
[newapi-response-dto]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/relaykit/dto/openai_response.go#L82-L125
[newapi-stream]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/relay/helper/stream_scanner.go#L83-L316
[newapi-final]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/relay/channel/openai/helper.go#L193-L207
[newapi-response]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/relay/channel/openai/relay-openai.go
[newapi-error]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/service/error.go#L87-L162
[newapi-chat-helper]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/relay/compatible_handler.go#L39-L166
[newapi-channel-types]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/constant/channel.go#L3-L65
[newapi-adaptor]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/relay/channel/openai/adaptor.go
[newapi-init]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/common/init.go
[newapi-url]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/relay/common/relay_utils.go#L26-L39
[newapi-global]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/setting/model_setting/global.go#L38-L66
[newapi-mapping]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/relay/helper/model_mapped.go
[newapi-channel-doc]: https://docs.newapi.pro/zh/docs/guide/feature-guide/admin/channel
[newapi-capabilities]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/relaykit/dto/openai_request.go#L320-L382
[newapi-filter]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/relay/common/relay_info.go#L1140-L1223
[newapi-deepseek]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/relay/channel/deepseek/constants.go
[newapi-builtin-prices]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/setting/billing_setting/builtin_billing.go
[newapi-defaults]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/common/constants.go
[newapi-relay-loop]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/controller/relay.go#L141-L228
[newapi-retry]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/service/relay_error.go#L18-L62
[newapi-http]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/service/http_client.go#L103-L133
[newapi-request-context]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/relay/channel/api_request.go#L315-L341
[newapi-request-do]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/relay/channel/api_request.go#L528-L572
[newapi-price]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/relay/helper/price.go#L76-L215
[newapi-quota-config]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/setting/operation_setting/quota_setting.go#L11-L22
[newapi-billing-session]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/service/billing_session.go#L193-L353
[newapi-usage-estimate]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/service/usage_helpr.go#L23-L30
[newapi-usage-path]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/service/billing_usage.go
[newapi-log]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/model/log.go#L278-L402
[newapi-log-setting]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/setting/operation_setting/log_setting.go#L12-L25
[newapi-log-delete]: https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/model/log.go#L771-L795

[azure-v1]: https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle?tabs=key
[azure-dated]: https://learn.microsoft.com/en-us/azure/foundry/openai/reference
[azure-integrate]: https://learn.microsoft.com/en-us/azure/foundry/how-to/integrate-with-other-apps
[azure-models]: https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure?pivots=azure-direct-others&view=foundry-classic
[azure-retirement]: https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule
[azure-chat]: https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/chat
[azure-reasoning]: https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-chat-reasoning
[azure-quota]: https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota
[azure-partners]: https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-from-partners
[azure-privacy]: https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/data-privacy
[azure-abuse]: https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/abuse-monitoring
[azure-terms]: https://www.microsoft.com/licensing/terms/en-US/productoffering/MicrosoftAzure/allprograms
[azure-deployments]: https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/deployment-types
[azure-pricing]: https://azure.microsoft.com/en-us/pricing/details/ai-foundry-models/deepseek/
[azure-cost]: https://learn.microsoft.com/en-my/azure/foundry/concepts/manage-costs?view=foundry-classic
[azure-latency]: https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/latency
[azure-budgets]: https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets
