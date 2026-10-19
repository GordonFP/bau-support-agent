# Pi SDK：MCP 接入、会话隔离与模型调用研究

查验日期：2026-10-19。关联研究票：[Pi SDK 如何安全加载 MCP 工具并调用模型？](https://github.com/GordonFP/bau-support-agent/issues/2)。

**静态研究结论：可以继续离线 POC。** 固定 Pi 1.3.0，通过 `createAgentSession()` 进程内集成。建议用第一方 `@earendil-works/pi-mcp` 管理协议连接，再以受控 `customTools` 接入 Pi，把服务端授权、脱敏和审计放进每次工具执行的必经路径。Pi 现在也提供第一方 `createMcpExtension()`；SDK 不自动加载它，且其默认配置发现、资源工具、落盘和 hook 异常语义需要额外收束。以下建议尚未成为已批准的生产方案。

本次只读取官方资料、公开发布包和源码；未安装依赖、执行包或示例、调用模型、使用模型凭据、连接 MCP/生产环境。研究完成表示证据足够支撑下一步决策，不表示运行兼容性或生产安全已经通过。

## 【已确认事实】版本与证据边界

| 项目 | 固定证据 |
|---|---|
| npm 当前 `latest` | `@earendil-works/pi-coding-agent@1.3.0`，发布时间 `2026-10-15T19:13:30.662Z`；同版 `pi-ai`、`pi-agent-core`、`pi-mcp` 均为 1.3.0。[npm 元数据][npm] |
| 官方仓库与版本 | `earendil-works/pi`，tag `v1.3.0` → Commit `71023aec1546d6d677a65669c5665c0927ce0dd0`。[固定源码][release] |
| 包与源码关联 | 读取 npm 发布 provenance，记录的 `gitCommit` 与上述 Commit 一致。下载四个 1.3.0 tarball，逐一校验 SHA-512 与 registry `dist.integrity` 一致；SDK 工厂、MCP Extension、OpenAI Responses、Agent 类型、MCP Client 的发布 source map 内嵌源码均与固定 Commit 对应文件一致。此操作没有验证 attestation 的签名信任链。[provenance][provenance] |
| Node / 模块 | 包 `engines.node >=22.19.0`；ESM，根入口 `dist/index.js`，声明 `dist/index.d.ts`，SDK 与 CLI 同包，无需启动 CLI。[package.json][pkg] |
| TypeScript | 上游开发依赖 TypeScript `7.0.2`，构建目标 ES2024、Node16 module resolution。包未声明下游消费者最低 TypeScript 版本；不能据此声称旧 TS 编译器兼容，须以项目实际编译器验证发布声明。[仓库配置][root-pkg]、[tsconfig][tsconfig] |
| 许可证 | 上述 Pi 包声明 MIT；保留版权与许可文本，许可证含无担保条款。这里只核验 Pi 顶层声明，未完成传递依赖许可证清单或漏洞扫描。[LICENSE][license] |
| 维护风险 | 2026-10 已发布 1.0、1.1、1.2、1.3；1.2 有 breaking changes，1.3 修复内部包混版、工具参数验证及会话恢复等问题。应锁精确版本与 lockfile，升级重跑边界测试；不能把“已到 1.x”当生产保证。[Changelog][changelog] |

来源优先级是发布包声明与实现、固定 Commit、官方滚动文档。Context7 用于定位，关键结论均回链原始资料；滚动网页变化后不覆盖这里固定版本的判断。

## 【已确认事实】直接 SDK 入口与工具契约

1. 根包导出 `createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>`。结果含 `session: AgentSession`、`extensionsResult`、可选 `modelFallbackMessage`。主要选项是 `cwd`、`agentDir`、`modelRuntime: ModelRuntime`、`model: Model<any>`、`thinkingLevel`、`tools: string[]`、`noTools: "all" | "builtin"`、`excludeTools: string[]`、`customTools: ToolDefinition[]`、`resourceLoader`、`sessionManager`、`settingsManager`、`sessionStartEvent`。`tools` 是名字/模式列表，不是工具实例数组；旧示例中的 `continueSession` 不是这个接口的字段。[实际类型与工厂][sdk]
2. `ToolDefinition` 必需字段是 `name`、`label`、`description`、`parameters: TSchema`，执行签名为 `execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>`，第五参是 `ExtensionToolContext`。当前 Schema 库是 `typebox`；可选 `executionMode`、`exposure`、`outputSchema`、`constrainedSampling` 等。可通过 `customTools` 注册，也可由审核过的 Extension 调用 `pi.registerTool()`。[工具类型][tool-type]
3. `AgentToolResult` 的模型可见部分是 text/image `content`；还可带 `details`、`structuredContent`、`isError`、`usage`。`details` 与结构化结果仍可能被程序、会话或间接工具读取，不能只净化 `content`。业务失败可以返回安全的 `isError` 结果；异常信息也应先转换为安全错误，不能透传上游错误正文。[结果类型][result-type]、[执行错误转换][agent-loop]
4. `session.prompt()` 等待一次运行（含自动恢复）结束；`subscribe()` 提供工具、消息及运行事件。`agent_settled` 表示没有后续自动继续，单个 `agent_end` 不足以表示最终结束。同一 session 忙时，新的 prompt 需要显式 `streamingBehavior`，否则拒绝；`steer`/`followUp` 是同一会话队列，不是用户隔离机制。[SDK 生命周期][sdk-doc]

## 【已确认事实】默认行为不能直接用于服务端

- 不传覆盖项时，SDK 创建文件型 Settings、持久 Session、ModelRuntime 和 DefaultResourceLoader，默认工具包含 `read`、`bash`、`edit`、`write`。`cwd` 只是工具路径和发现范围的起点，不是文件系统沙箱。[SDK 默认值][sdk-default]、[安全说明][security]
- `DefaultResourceLoader` 会处理配置包、扩展、技能、Prompt、主题、上下文与 SYSTEM/APPEND_SYSTEM 文件。`noExtensions` 仍保留显式追加路径和 inline factories；`noSkills` 等也允许显式追加来源。`noContextFiles` 关闭上下文读取，但不自动等于关闭所有提示文件发现；这些开关不是一个总的“安全模式”。[资源加载实现][resource-load]
- SDK 工厂直接 `loader.reload()`，不自动执行 CLI 的信任交互；`SettingsManager` 创建时的 `projectTrusted` 默认是 `true`。不能假设 SDK 自带 CLI 的“陌生项目先询问”保护。[SDK 创建路径][sdk-default]、[Settings 创建][settings-create]
- 自定义 `ResourceLoader` 是正式接口，可仅返回审核过的排障技能和固定提示内容，空扩展、空模板、空上下文，并禁用 `extendResources` 动态追加；官方 full-control 示例展示了完整接口。它比组合许多发现开关更容易审计。[ResourceLoader][resource-type]、[完整控制示例][full-control]
- 工具 `readOnlyHint` 等是服务端声明的提示，不能据此授权；应按审核过的真实工具契约、凭据能力和目标资源规则判断。[MCP 工具规范][mcp-spec]

## 【已确认事实】MCP 已有第一方支持，但有两种接入层

### A. 第一方 MCP Extension

`createMcpExtension(options?: McpExtensionOptions): ExtensionFactory` 已从 SDK 根包导出。其选项包括 `loadConfig(ctx): LoadedMcpConfig`、`createTransport`、`credentials`、`logPath`、`openUrl`、`updateConfig` 和 `startupWaitMs`。`LoadedMcpConfig` 含 `servers`、`errors`、可选 `autoEnableCodemode` 与 `projectConfig`。SDK 应在 ResourceLoader 中显式加入工厂、先 `reload()`，创建 session 后 `await session.bindExtensions({})` 触发 `session_start`；不能把 CLI 参数或未核验的旧 MCP 配置当作 SDK 自动行为。[Extension 签名][mcp-extension]、[官方 SDK 示例][mcp-example]

Extension 支持 stdio 与 Streamable HTTP，不支持旧 SSE transport；默认读取 agent 目录的 `mcp.json` 和被信任项目的 `.pi/mcp.json`。文件配置优先于同名 `pi.registerMcpServer()` 注册。stdio 会启动配置的可执行文件；env/header 配置还支持 `!command`，最终可调用 Shell。因此“模型没有 bash 工具”不等于默认 MCP 启动路径不会执行命令。[MCP 配置][mcp-config]、[transport 实现][mcp-transport]、[命令解析][resolve-value]

工具默认 exposure 是 `codemode`；`direct` 直接声明给模型，`deferred` 通过工具搜索加载，`hidden` 不可达。SDK 需要自行加入 codemode/tool-search Extension 才有对应能力；本 POC 没有必要为了调用少量只读工具引入模型脚本执行。MCP Extension 还会注册资源列表/读取工具、接受工具列表变更、把服务端描述加入模型上下文。资源工具能够访问多个已启用服务器，必须纳入同样授权范围。[官方 MCP 行为][mcp-doc]、[资源注册实现][mcp-resource-reg]

**允许列表有特殊语义：** `tools: ["approved_tool"]` 不会自动删除所有已注册 MCP 工具；当列表非空且没有 `mcp__` 项时，MCP 工具可保留给 codemode/deferred 路径。需要限制 MCP 时使用精确 `mcp__...` 名称并检查实际注册名，或显式 `excludeTools: ["mcp__*"]`。`tools: []` / `noTools: "all"` 可以全部关闭；只有 `+name/-name` 的列表是在修改默认集，不是严格白名单。不可仅断言 `getActiveToolNames()` 来证明间接工具不可达。[SDK 允许列表说明][sdk-allow]、[注册与可调用过滤][tool-filter]

默认 MCP 结果超过阈值会把完整文本写临时文件，二进制资源也可能落盘；工具进度原文可进入更新事件，MCP 服务端日志另有日志文件。这发生在结果 hook 之前，事后只脱敏最终文本不足以保护本地副本和事件。[结果转换与落盘][mcp-result]、[工具执行与进度][mcp-tool-exec]

### B. 第一方独立 MCP Client + 受控 customTools

`@earendil-works/pi-mcp@1.3.0` 是官方独立 Client，根包导出 `McpClient`、`StreamableHttpTransport`、`StdioTransport` 和协议类型。实际接口包括 `connect(transport)`、`listTools(options?)`、`callTool(name, args?, {signal?, timeoutMs?, onProgress?})`、`close()`；无需加载 MCP Extension，也无需自己实现 MCP wire protocol。[独立 Client 导出][mcp-client-export]、[Client 调用契约][mcp-client]

固定版协商列表是 `2025-11-25`、`2025-06-18`、`2025-03-26`、`2024-11-05`，服务端选择未支持版本时连接失败。两个实际 MCP 服务是否支持兼容协议、transport 和 schema，仍需各自版本及运行验证。[协议列表][mcp-protocol]

## 【已确认事实】hook 的阻断能力有差异

| 路径 | 固定版真实行为 | 对安全控制的含义 |
|---|---|---|
| `tool_call` | `block: true` 停止；handler 异常向外传播，AgentSession 明确按阻断处理 | 可做额外授权门，但仍须在实际 Adapter 再鉴权。[调用 hook][hook-call] |
| `tool_result` | handler 异常被记录，随后继续；没有修改结果时保留原结果 | 不能用“脱敏抛错”实现默认拒绝。[结果 hook][hook-result] |
| `context` / `context_with_system` | handler 异常被记录后继续处理上下文 | 不能充当唯一模型前脱敏边界。[上下文 hook][hook-context] |
| `before_provider_request` | handler 异常被记录，当前 payload 仍可继续 | 不能仅靠这个 hook 抛错阻止敏感请求。[Provider hook][hook-provider] |
| 间接 `ctx.executeTool()` | 经 session 工具 pipeline，带 `parentToolCallId` | 审计/授权须覆盖子调用；任意 Extension 自己发网络请求不受此工具路径约束。[嵌套调用][nested] |

## 【技术假设/建议】POC 的最小集成方式

**优先验证 B 路径。** 只复用官方 Client 做连接/协议，用薄 Adapter 把批准的读工具变成固定 `ToolDefinition`，不动态把整个 `listTools` 结果交给模型。A 路径也是有效第一方选项，但需证明配置、日志、临时文件、资源工具及所有 hook 失败路径均符合边界；默认加载示例不能直接成为服务端安全方案。

建议的封装关系是：可信消息入口 → `AgentRuntimeAdapter` → Pi session → `AuthorizedReadToolAdapter` → `McpConnectionAdapter` → 批准的 MCP 服务。外部 SDK 类型止于基础设施 Adapter。模型只产生业务查询参数，不产生身份、角色、凭据、任意 endpoint、索引或仓库权限。

工具调用的强制顺序：

1. 从宿主持有的不可变上下文取得调用人、session、实际受众和授权策略版本；校验工具、输入 schema、参数范围、目标资源和成本上限。
2. 写入脱敏后的授权/拒绝审计；拒绝、授权服务异常或必要审计失败时，不发 MCP 请求。
3. 通过只读凭据调用固定 MCP 端点，绑定取消信号与绝对截止时间；不用模型参数选择端点或凭据。
4. 对完整结果、`structuredContent`、`details`、进度、异常、资源链接与附件统一做筛选/脱敏/大小限制；不把未审核资源读取通道交给 Pi。无法净化则返回固定安全错误，原始异常不进入 Pi。
5. 记录结果和证据版本审计后，仅将安全结果返回 Pi；输入和恢复的历史在进入 Pi 前也已净化。模型上下文 hook 可复查，不能替代以上边界。
6. 报告发送前按当前实际受众再校验披露范围；模型输出不直接决定群组授权。

生产运行态只注册固定 custom tool 名称，采用 `tools: [精确名称...]`，并防御性排除 `bash`、`powershell`、`edit`、`write`、`codemode`、`tool_search`、`mcp__*`；不提供本地通用 `read/grep/find/ls`。自定义 ResourceLoader 只保留审核过的排障技能；建议宿主校验其内容/版本后显式注入固定系统提示，避免为了读技能文件开放通用 `read`。技能元数据本身不作为“内容已应用”的验收证据。禁止开发技能、外部包、任意 Extension 和上下文自动发现；普通用户输入使用 `expandPromptTemplates: false`，不映射管理命令。不要将 `session.agent`、`executeBash()`、`pi.exec()` 等宿主能力映射为用户接口。

上述配置限制模型可达工具，并不剥夺 Node 进程本身的权限。还需非 root、只读挂载、无业务代码写凭据、固定网络出口与 MCP 服务端只读权限；MCP 管理/索引更新由独立管理路径负责。若必须 stdio，只有运维审核的固定可执行入口可启动，不允许用户/模型选择命令或 `!command`。普通排障流程优先远程 HTTP 或受控 MCP sidecar。

### Adapter / 工具契约草案（类型文字，非业务实现）

```text
InvocationContext = readonly {
  principal: TrustedPrincipal; sessionKey: OpaqueSessionKey;
  audience: DisclosureScope; resourceScope: ApprovedResourceScope;
  policyVersion: string; deadline: Instant; signal: AbortSignal;
}

AgentRuntimeAdapter.open(context, approvedModelRef) -> IsolatedSession
IsolatedSession.run(sanitizedInput) -> AsyncIterable<SafeEvent> + FinalReport
IsolatedSession.abort() -> Promise<void>
IsolatedSession.close() -> Promise<void>

McpConnectionAdapter.call(approvedToolRef, validatedArgs, trustedContext)
  -> Promise<UntrustedToolResult>   // 原始结果止于 Adapter 内部

AuthorizedReadToolAdapter.execute(validatedArgs, trustedContext)
  -> Promise<SafeToolResult>       // 内部强制鉴权、脱敏、审计，失败默认拒绝

SafeToolResult = {
  content: SafeText[]; evidence: EvidenceRef[];
  status: success | denied | unavailable | cancelled | stale;
}
EvidenceRef = { repositoryAlias?, branch?, commit?, indexTime?, evidenceVersion }
```

Pi 包装器闭包绑定 `InvocationContext`，只把已净化的 `SafeToolResult` 翻译成 `AgentToolResult`。MCP 连接只向 Adapter 可见；不向工具 schema 暴露 `principal`/`policyVersion` 或可覆盖 trustedContext 的字段。工具名称和参数须等 MCP 契约研究完成后确定，以上没有假定真实工具名。

## 【已确认事实 + 技术建议】并发、生命周期与失败

- 每次 `createAgentSession` 构造独立 Agent、消息、队列、工具注册与运行状态；`SessionManager.inMemory(cwd, options?, entries?)` 不持久化会话文件。每个授权边界创建独立 session、SessionManager、SettingsManager、ResourceLoader、工具闭包和 MCP 状态；禁止共享可变消息或当前用户全局变量。MCP 工厂的连接状态在其 session factory 内持有。[创建 Agent][agent-create]、[内存 session][memory-session]、[MCP 状态][mcp-state]
- `inMemory` 只是存储方式，不是租户鉴权/沙箱。建议 session key 包含租户、会话、授权主体与披露范围；群聊实际调用人每次可信绑定。相同 session 串行处理，不同 session 并发；取消 A 不得中止 B。按用户/会话/资源/版本/策略分区缓存，不能只用查询字符串作缓存键。
- `ModelRuntime` 含可变凭据、模型与扩展 Provider 配置；不要把带用户凭据的 runtime 全局共享。只有经证明无跨身份可变状态的服务账号 runtime 才考虑复用；第一阶段先按安全域隔离。[ModelRuntime 配置与状态][model-runtime]
- `await session.abort()` 中止重试、压缩、摘要和 Agent 后等待 idle；`dispose()` 是同步清理，不等价于所有外部异步连接已经关闭。MCP Extension 关闭连接在 `session_shutdown` handler；`AgentSessionRuntime.dispose()` 会先发 shutdown，普通 `session.dispose()` 源码没有这一步。若用 A，须验证并使用正确 shutdown 生命周期；B 由 Adapter 明确 `await client.close()` 后清理 session。[中止][abort]、[普通 dispose][dispose]、[runtime dispose][runtime-dispose]、[MCP shutdown][mcp-shutdown]
- MCP timeout 在 progress 到来时重新计时，不能代替整体 deadline。建议宿主绝对截止时间主动 Abort，MCP 每调用 timeout、Provider timeout、最大轮次/工具数、总 token/成本和队列上限分别控制；关闭缓存预热和不需要的自动压缩/重试，随后逐项验证。取消是协作协议，不能承诺撤销已发生的上游执行。[MCP timeout][mcp-timeout]、[请求参数与取消][request-options]
- 上游断开、鉴权失败、schema 不符、版本不明或证据过期时输出明确的安全降级结果；仅对确认幂等的读操作按预算重试。不得通过开放 Shell、写工具或扩大资源范围来“恢复”。

## 【已确认事实】Provider 与工具协议兼容性

Pi 使用 `pi-ai` Provider 抽象，API 类型包含 `openai-responses`、`openai-completions`、`azure-openai-responses`、`openai-codex-responses`、`anthropic-messages`、`bedrock-converse-stream`、`google-generative-ai`、`google-vertex` 等；API 标签存在不等于任意网关、任意模型都支持工具。公司生产模型、托管区域、账号类型、数据政策和预算仍未确定；开发助手正在使用的 GPT 型号不构成生产选型。[API 类型][api-types]

| 核对项 | 1.3.0 静态结论 |
|---|---|
| OpenAI 直接 Provider | `openaiProvider()` 使用 `https://api.openai.com/v1` 和 `openAIResponsesApi()`；实现实际调用 `client.responses.create()`，非仅有类型标签。[Provider][openai-provider]、[HTTP 调用][openai-call] |
| 工具往返 | Pi 将工具转换为 Responses function tools，保存 `call_id`，以 `function_call_output` 传回结果，并处理 reasoning 项；通常不需要另套 OpenAI Agents Framework。[工具转换][responses-tools]、[往返转换][responses-roundtrip] |
| Strict schema | Pi Responses 转换默认 strict 为 false；可用 `constrainedSampling: {type: "json_schema", strict: "require"}` 请求约束，但仍需执行前 schema 校验与授权。不要把模型结构化输出当安全检查。[strict 转换][responses-tools]、[配置类型][sampling] |
| OpenAI 当前接口限制 | OpenAI 官方文档当前说明 GPT-6 Astra、GPT-6.1 Sol 的工具调用必须用 Responses；GPT-6 Sol/Luna 在 Chat Completions 仅 `reasoning_effort: "none"` 支持函数调用。这里只说明接口边界，不推荐生产型号。[部署文档][openai-deploy] |
| Responses 调用规则 | 官方要求工具结果关联 `call_id`，reasoning 模型的相关 reasoning items 也须随工具结果继续传回；strict schema 要求需按官方规则核对。Pi 的转换路径有对应实现，但真实选定模型仍待运行验证。[Function calling][openai-tools] |
| 数据保留 | Pi Responses payload 设置 `store: false`。这不证明提供商零保留、区域合规或公司政策已满足；须另核对企业协议和最终配置。[payload][openai-payload] |

MCP 与模型 Provider 是不同协议层：应用调用 MCP，再把安全结果作为 Pi function tool 的结果交给 Provider。OpenAI Responses 的托管 remote MCP 能力不自动等于 Pi MCP Extension，也不应绕过本应用的授权/脱敏路径。OpenAI-compatible 网关必须逐项验证 endpoint、模型 ID、schema、strict、工具参数流、并行工具、reasoning 重放、错误与取消；不能因“兼容 Chat Completions”推断支持 Responses 或最新模型。

## 【待安装/运行验证】下一阶段最小清单

全部先用合成样本、Mock Provider 和 Mock MCP；本次未执行以下任一项。

| 验证 | 最小通过标准 |
|---|---|
| 发布包与构建 | 在批准的 Node 镜像安装精确 1.3.0 与 lockfile，实际 TS 编译、ESM import、构建通过；导出/依赖、许可证清单和安装副作用有记录。 |
| 工具与发现边界 | 临时 HOME/cwd 中放入合成恶意扩展、技能、SYSTEM/AGENTS、MCP 配置；启动不加载。只有批准工具注册、声明、可间接执行；bash/写/索引管理、资源读取和新出现工具一律不可达。 |
| MCP 契约 | 固定两个上游 MCP 版本，核验 transport、协议协商、工具名/schema、只读语义、返回块、分页与证据版本字段；契约漂移拒绝启动或拒绝调用。 |
| 强制安全路径 | 未授权用户、越界资源、伪造身份参数、授权/脱敏/审计服务异常均不导致原始数据发给 Pi；拒绝时 MCP 未被调用。扫描模型请求、更新事件、历史、缓存、临时文件、日志、错误与审计确认没有合成敏感标记。 |
| 注入防御 | 合成日志/代码/工具描述含改权限、执行命令、外传指令；实际工具集与授权不变，结果以数据进入上下文；输出到群组前经过受众检查。 |
| 并发隔离 | 两个用户、多会话交错调用，消息、记忆、工具闭包、凭据、证据、队列与缓存不串；A 取消/超时不影响 B；相同 session 按既定串行规则处理。 |
| 生命周期 | 连接失败、反复重连、持续 progress、Provider 429/5xx、Abort、shutdown 后迟到响应均按预算终止；无连接/worker 泄漏；不把未完成事件当最终报告。 |
| 选定模型的工具闭环 | 获得模型测试授权后，用合成输入完成 prompt → tool call → safe tool result → final answer；验证多工具/无效 JSON/strict/reasoning、超时、成本。记录 Provider、模型 ID、API、版本及结果。 |

## 【人工决策 / POC 阻断】

- **可完成本研究票**：SDK 入口、第一方 MCP 两条路径、默认风险、隔离设计、Provider 边界及下一步验证已获得静态证据。无需为了没有安装运行而阻塞静态研究的关闭。
- **进入模型测试前**：决定允许的 Provider/具体模型/API/部署区域、凭据方式和数据保留政策；取得适用测试授权。未决定时继续 Mock，不代选型号。
- **进入真实 MCP/试点前**：固定实际 MCP 版本与只读工具/资源契约，确定可信身份与授权范围、证据版本规则、审计与脱敏失败策略；取得明确生产只读访问批准。资源清单不是访问批准。
- **POC 安全 Go 条件**：上述工具边界、强制安全路径、会话隔离、取消及报告披露验证全部通过。若无法证明无 Shell/写能力、结果在模型前完成净化，或任一调用能绕过服务端授权/必要审计，则阻断真实试点；不以 System Prompt、readOnlyHint 或 hook 日志代替通过证据。

## 验证记录

已执行：完整读取研究票正文、状态、标签、负责人、评论与里程碑；官方网页与固定源码静态查阅；四个 npm tarball integrity 比对；关键发布 source map 与 Commit 文件比对；研究文档结构和固定链接本地检查。

未执行：依赖安装、SDK/示例执行、类型检查、构建、自动化运行测试、真实模型/MCP/生产访问、传递依赖安全扫描、attestation 签名信任链验证。以上均未记作通过。

[npm]: https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.3.0
[release]: https://github.com/earendil-works/pi/tree/71023aec1546d6d677a65669c5665c0927ce0dd0
[provenance]: https://registry.npmjs.org/-/npm/v1/attestations/@earendil-works%2fpi-coding-agent@1.3.0
[pkg]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/package.json#L1-L35
[root-pkg]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/package.json
[tsconfig]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/tsconfig.base.json
[license]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/LICENSE
[changelog]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/CHANGELOG.md#L3-L104
[sdk]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/sdk.ts#L48-L116
[tool-type]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/extensions/types.ts#L579-L656
[result-type]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/agent/src/types.ts#L424-L444
[agent-loop]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/agent/src/agent-loop.ts#L804-L902
[sdk-doc]: https://pi.dev/docs/latest/sdk
[sdk-default]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/sdk.ts#L191-L207
[security]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/docs/security.md#L1-L33
[resource-load]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/resource-loader.ts#L529-L659
[settings-create]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/settings-manager.ts#L309-L363
[resource-type]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/resource-loader.ts#L153-L164
[full-control]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/examples/sdk/12-full-control.ts#L28-L61
[mcp-spec]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/server/tools.mdx
[mcp-extension]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/extensions/mcp/index.ts#L69-L91
[mcp-example]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/examples/sdk/14-codemode-mcp.ts#L13-L50
[mcp-config]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/extensions/mcp/config.ts#L1-L153
[mcp-transport]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/extensions/mcp/runtime.ts#L98-L121
[resolve-value]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/resolve-config-value.ts#L80-L85
[mcp-doc]: https://pi.dev/docs/latest/mcp
[mcp-resource-reg]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/extensions/mcp/index.ts#L466-L494
[sdk-allow]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/sdk.ts#L64-L94
[tool-filter]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/agent-session.ts#L1538-L1571
[mcp-result]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/extensions/mcp/tools.ts#L180-L285
[mcp-tool-exec]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/extensions/mcp/tools.ts#L312-L349
[mcp-client-export]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/mcp/src/index.ts
[mcp-client]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/mcp/src/client.ts#L378-L393
[mcp-protocol]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/mcp/src/protocol/types.ts#L1-L10
[hook-call]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/extensions/runner.ts#L1249-L1266
[hook-result]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/extensions/runner.ts#L1190-L1246
[hook-context]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/extensions/runner.ts#L1300-L1365
[hook-provider]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/extensions/runner.ts#L1368-L1396
[nested]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/agent-session.ts#L727-L766
[agent-create]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/sdk.ts#L411-L478
[memory-session]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/session-manager.ts#L1803-L1805
[mcp-state]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/extensions/mcp/index.ts#L279-L312
[model-runtime]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/model-runtime.ts#L109-L197
[abort]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/agent-session.ts#L2461-L2480
[dispose]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/agent-session.ts#L1393-L1418
[runtime-dispose]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/agent-session-runtime.ts#L404-L410
[mcp-shutdown]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/extensions/mcp/index.ts#L1252-L1258
[mcp-timeout]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/mcp/src/client.ts#L536-L568
[request-options]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/sdk.ts#L340-L365
[api-types]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/types.ts#L61-L83
[openai-provider]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/providers/openai.ts#L9-L34
[openai-call]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/api/openai-responses.ts#L203-L218
[responses-tools]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/api/openai-responses-shared.ts#L385-L420
[responses-roundtrip]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/api/openai-responses-shared.ts#L265-L371
[sampling]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/types.ts#L737-L758
[openai-deploy]: https://developers.openai.com/api/docs/guides/deployment-checklist
[openai-tools]: https://developers.openai.com/api/docs/guides/function-calling
[openai-payload]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/api/openai-responses.ts#L355-L365
