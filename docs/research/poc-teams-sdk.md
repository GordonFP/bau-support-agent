# Teams SDK：可信身份、会话与群组回复研究

查验日期：2026-10-19（Asia/Singapore）。研究问题：[Teams SDK 如何提供可信身份、会话与群组回复？](https://github.com/GordonFP/bau-support-agent/issues/3)。这是公开资料与公开包的静态技术调查，不代表已完成 POC、租户授权或生产可用性验证。

## 结论与建议范围

- **【已确认事实】** 官方 Node/TypeScript 服务端入口是 `@microsoft/teams.apps`，本次 npm `latest` 为 **2.1.1**，需要 **Node.js >=22.12.0**，许可证 **MIT**；官方源码固定为 tag `v2.1.1`、Commit `79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81`。2.1.1 修复了入站 Entra Agent ID token 的调用方限制，不能以旧版认证示例代替。[npm 固定版本元数据](https://registry.npmjs.org/@microsoft%2Fteams.apps/2.1.1)、[官方发行说明](https://github.com/microsoft/teams.ts/releases/tag/v2.1.1)。
- **【已确认事实】** Bot 回调的服务身份认证、用户 SSO/Entra 身份、用户读取业务资源的权限、向会话受众披露结果的权限，属于不同保证。SDK 处理前两者的协议；后两者必须由后端授权规则决定。SSO 官方支持私聊和群聊，**不支持频道 scope 的静默 SSO**。[入站认证源码](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/src/middleware/auth/inbound-activity-token-validator.ts#L65-L122)、[SSO scope](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/authentication/bot-sso-overview#sso-user-experience-in-teams)。
- **【技术假设/建议】** POC 先声明支持私聊、被明确授权的群聊 `@Mention`；频道须作为单独的能力与验收项。频道线程回复 API 已有，但频道 SSO、成员完整性、共享/私有频道的实际受众与身份映射仍须逐项实测。群组受众未知时不发送敏感报告，仅给通用状态并引导至已授权私聊或逐次鉴权的受控报告链接。
- **【人工决策/POC阻断】** 必须确定业务资源授权的权威来源、Entra 身份到资源身份的映射、群组允许披露的规则，以及真实测试租户/应用/受众的批准范围。没有这些决定，SDK 接通也不能证明安全群组报告交付。

## 1. 固定依赖与证据边界

| 公开包 | 查验版本 / npm 发布时间（UTC） | 用途与约束 |
| --- | --- | --- |
| `@microsoft/teams.apps` | 2.1.1 / 2026-10-16 21:32:24 | App、消息路由、入站认证、OAuth、回复；Node >=22.12.0，MIT |
| `@microsoft/teams.api` | 2.1.1 / 2026-10-16 21:32:41 | Activity 类型、Teams API 客户端；同一 Node / MIT 要求 |
| `@microsoft/teams.common` | 2.1.1 / 2026-10-16 21:36:48 | 共享 HTTP、存储、日志基础设施；同一要求 |
| `@microsoft/teams.graph` | 2.1.1 / 2026-10-16 21:32:15 | Graph 客户端；同一要求，不自动授予 Graph 权限 |

**【已确认事实】** 以上版本与时间来自 npm registry 完整元数据；实际 tarball 的 `package.json`、`dist/*.d.ts` 已下载静态读取，并逐一核对 tarball SHA-512 与 registry `dist.integrity` 一致。`teams.apps` 的已发布包把以上三项依赖固定到 2.1.1，入口包含 CommonJS `dist/index.js`、ES module `dist/index.mjs` 与声明 `dist/index.d.ts`。这不是安装或执行。公开检索入口：[apps](https://registry.npmjs.org/@microsoft%2Fteams.apps)、[api](https://registry.npmjs.org/@microsoft%2Fteams.api)、[common](https://registry.npmjs.org/@microsoft%2Fteams.common)、[graph](https://registry.npmjs.org/@microsoft%2Fteams.graph)。

**【已确认事实】** 固定 tag 的 `version.json` 为 2.1.1；源码 workspace 的 `packages/apps/package.json` 仍用构建占位版本 `0.0.0`，因此不能把源码目录版本字段误当 npm 发布版本。官方 Learn TypeScript API 首页本次仍展示 2.1.0，晚于它的 npm 2.1.1 与发行说明应作为本次基线。[版本文件](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/version.json#L1-L4)、[源码包定义](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/package.json#L1-L24)、[Learn API 索引](https://learn.microsoft.com/en-us/javascript/api/teams-sdk-typescript)。

**【已确认事实】** 官方仍在发布和维护此 SDK；本次核对的 2.1.1 release 标为非 prerelease，官方 2026-09-28 公告列出 TypeScript 2.1 发布。MIT 要求保留版权与许可文本，并提供无担保条款；活跃发布不等于对本项目组合、所有租户或所有 preview API 的生产保证。[开发公告](https://learn.microsoft.com/en-us/microsoftteams/platform/developer-announcements)、[MIT 原文](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/LICENSE#L1-L21)。

**【技术假设/建议】** 首次实施锁定上述精确版本与 lockfile，随后做依赖安全检查；本次未安装、未解析完整传递依赖树、未做漏洞扫描。使用 `App`、`MessageActivityInput`、`OAuthFlow` 等该版本 API，不套用 `botbuilder` 的 `TurnContext` / `CloudAdapter`、Microsoft 365 Agents SDK 或浏览器 `@microsoft/teams-js` 示例。官方还将 `teams.ai`、`teams.openai`、`teams.mcp` 等标为 deprecated；本通信 Adapter 不需要引入它们。[官方包清单与弃用项](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/README.md#L63-L91)。

## 2. 认证与可信身份的边界

### Bot 入站请求

**【已确认事实】** 默认 HTTP 路径是 `POST /api/messages`。HTTP server 在分派 Activity 前检查认证，无凭据或缺少/无效 Authorization 时拒绝；`dangerouslyAllowUnauthenticatedRequests` 会绕过此检查。其默认值为 false，但兼容的 `skipAuth` 或环境变量 `DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS` 也可能影响它。生产配置应显式保持 false，并阻止未经认证的自定义 transport 注入预认证 token；`handleRequest` 将 transport 提供的 `request.token` 当作已认证输入。[HTTP 认证入口](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/src/http/http-server.ts#L197-L271)、[配置解析](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/src/app.ts#L317-L354)。

**【已确认事实】** 常规 Teams Bot 路径验证 Connector 服务 token：从配置云的 JWKS 获取签名公钥，要求 RS256、有效期、应用 audience、精确服务 issuer；当 body 有 `serviceUrl` 时校验其与 token 的 `serviceurl` 一致。公网云 issuer 为 `https://api.botframework.com`。这证明请求持有受信服务签发、面向此应用的 token，不证明消息发送者已经完成用户 OAuth，也不授予日志或代码权限。[验证参数与 JWT 检查](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/src/middleware/auth/jwt-validator.ts#L92-L142)、[服务 URL 校验](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/src/middleware/auth/jwt-validator.ts#L256-L282)、[公网配置](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/api/src/auth/cloud-environment.ts#L25-L36)。

**【已确认事实】** 2.1.1 还接受 Agent 365 的 Entra 服务 token，验证其 tenant issuer、应用 audience，并限定 `azp`（缺失时 `appid`）为 Agent 365 平台；该路径目前没有签名的 `serviceurl` claim。它不是给用户 SSO token 直接调用 Bot 回调的入口。源码也没有将 Activity 中的租户字段与业务允许租户清单比较；配置 `tenantId` 不能代替业务租户授权。[完整入站分支](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/src/middleware/auth/inbound-activity-token-validator.ts#L40-L157)。

**【技术假设/建议】** POC 采用普通 Teams Bot / Connector 路径，不把 Agent 365 扩展当必要条件。只有经过 SDK 认证的 Activity 才能进入业务入口；边界再做 schema/必填字段校验、租户允许列表、recipient app / `channelId === 'msteams'` 检查、支持 scope 检查及消息去重。固定源码把 body cast 为 Activity，未提供这里所需的业务 schema 与授权校验。[Activity 分派源码](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/src/app.process.ts#L151-L170)。

### 用户 SSO 与身份映射

**【已确认事实】** 当前 API 以 `app.addOAuthFlow(connectionName)` 注册连接，再调用 `flow.signIn(ctx)`、`flow.getToken(ctx)`、`flow.onSignInComplete(...)`、`flow.signOut(ctx)`。`signIn` 已有 token 时直接返回；否则发 OAuth 卡并在后续 Activity 完成，原消息与任务不能只依赖当前 handler 闭包。旧 `ctx.signin`、`isSignedIn`、`userToken`、`userGraph` 为兼容 API，2.1 文档推荐显式 flow。OAuth 连接必须先在 Azure Bot 上配置；用户认证不能由本地 DevTools 证明。[OAuthFlow 源码](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/src/oauth/index.ts#L211-L369)、[2.1 用户认证指南](https://microsoft.github.io/teams-sdk/typescript/in-depth-guides/user-authentication/)。

**【已确认事实】** 用户 SSO 用用户身份和同意换取指定资源/权限范围的 token；SSO 支持 personal 与 groupChat，频道不支持。固定实现对频道不附带 `tokenExchangeResource`，群组/频道的登录卡会设置 targeted recipient，但 targeted API 仍标为 preview。这不应变成“频道静默 SSO 已支持”或“群组敏感交付已验证”的结论。[SSO scope 官方说明](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/authentication/bot-sso-overview)、[卡片构造分支](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/src/oauth/index.ts#L119-L167)、[targeted preview 标记](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/api/src/models/account.ts#L30-L37)。

| 字段或证据 | 可用于什么 | 不能推导什么 / 后端要求 |
| --- | --- | --- |
| 已认证 Activity 的 `conversation.tenantId`、`channelData.tenant.id` | Teams 会话的租户分区；SDK 按此前后顺序提取 | 不是业务允许租户清单；两者冲突、缺失时应拒绝或人工处理 |
| `activity.from.id` | 此 Bot/平台下发送者的 opaque 路由标识；OAuth 用户 token 服务以它索引 | 不是 Entra oid，不解析字符串来生成业务身份 |
| `activity.from.aadObjectId` / 成员查询返回的 `aadObjectId` 与 `tenantId` | 候选的 Entra 身份映射，必须保留来源与租户 | 字段可缺失，不能用姓名/email 猜测补齐；guest / federated 用户不得假设同租户 |
| `conversation.id`、`activity.id`、频道 thread root | 隔离会话/任务、去重、定位回复 | 不是成员列表，不是资源权限或保密等级 |
| `channelData.team.id`、`channelData.channel.id` | 平台资源定位、受众查询线索 | Team ID、Graph group ID、channel ID 不可互换；不能推定整个 Team 就是实际受众 |
| `name`、email、UPN、`userRole`、消息文本/卡片 payload | 展示或待校验输入 | 不能作为稳定身份或授权依据；mention 也不是授权 |
| 对本后端 API 的有效 Entra token / 受信身份映射 | 规范化 `(tenantId, objectId)` 及用户/调用方证明 | 仍需独立资源与披露授权；Graph token 只应用于 Graph，不把它当本后端 audience 的 token |

字段声明、可选性与 `userRole` 的授权警告见 [Account / ConversationAccount](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/api/src/models/account.ts#L6-L28)；成员 API 会将 `objectId` / `aadObjectId` 统一到后者，[身份字段规范化](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/api/src/models/account.ts#L131-L154)。SDK 的租户提取见 [extractTenantId](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/src/utils/tenant.ts#L1-L10)。

**【技术假设/建议】** 规范身份使用 `(Entra tenant, Entra object ID)`；明确区分“平台已认证的发送者映射”与“该连接已完成用户 SSO”。若本后端直接接收面向自己的 Entra access token，应验证签名、issuer、audience、有效期、tenant、用户/应用主体和 actor/scope；面向其他 API 的 access token 由对应资源服务器验证。GitLab、日志资源权限通过受信映射或独立授权服务取得，不能从 email、Teams 成员角色或“SSO 成功”直接派生。官方要求校验这些 claim，建议用 `tid`+`oid` 作稳定键，并明确禁止以 email、preferred_username 或 unique_name 判断授权。[Microsoft identity claims 验证](https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation)。

## 3. 消息 scope、Mention 与原会话回复

**【已确认事实】** 2.1.1 类型中的 `conversationType` 已知值是 `personal`、`groupChat`、`channel`，同时允许未来字符串；manifest bot scopes 使用 `personal`、`groupChat`、`team`。未知值不能落入“当作私聊”分支。群聊与频道默认接收对 Bot 的 `@Mention`，私聊无需 mention；额外消息读取授权（如 RSC）可能使未 mention 的消息也抵达，因此 POC 应主动守卫触发规则。[ConversationType](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/api/src/models/conversation-type.ts#L1-L7)、[群组会话协议](https://learn.microsoft.com/en-ca/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations)。

**【已确认事实】** `app.on('message', handler)` 处理消息；`app.on('mention', handler)` 由路由器检查 mention entity 的 `mentioned.id === activity.recipient.id`。`MessageActivity.isRecipientMentioned()` 同样匹配 recipient；不要仅搜索文本中的 `<at>` 或 bot 显示名。移除 mention 时只移除已验证指向当前 Bot 的 mention，保留其他被提及对象的语义。为防同时命中 message/mention 路由产生重复任务，可用一个 message 入口按 scope/mention 守卫，或验证路由顺序并去重。[路由器](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/src/router/router.ts#L140-L149)、[Mention 方法](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/api/src/activities/message/message.ts#L637-L658)。

| Scope | 事件与认证前提 | 同步/当前 turn 回复 | 诊断完成后的异步回复 |
| --- | --- | --- | --- |
| 私聊 personal | `message`；SSO 可用 | `ctx.send(activity)`；需要视觉引用时 `ctx.reply(activity)` | 持久化目的会话后 `app.send(conversationId, activity)` |
| 群聊 groupChat | POC 只处理对 Bot 的 mention；SSO 可用 | `ctx.send` 发到当前群；`ctx.reply` 增加引用 | `app.send` 发回原群；发送前重新授权全体受众 |
| 频道 channel（manifest team） | POC 单独批准，mention；无频道静默 SSO | `ctx.send` 在当前线程；`ctx.reply` 同线程并引用入站消息 | `app.reply(conversationId, threadRootId, activity)`；保存频道原 thread root |

**【已确认事实】** `ctx.send` 与 `ctx.reply` 的差别包含视觉 quote，不能把 quote 当作限制消息可见范围。`ctx.quote(messageId, activity)` 引用指定消息；频道当前 handler 的 send 使用入站 `ref`。异步 `App.reply` 构造 `;messageid=<root>` 的 conversation ID，再调用 App.send；helper 要求非零数字 root ID，并去除已有后缀。存储原始 conversation ID、规范 base ID 和 root ID，避免把某条回复的 activity ID 当根 ID。[Context 实现](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/src/contexts/activity.ts#L342-L429)、[App.send/reply](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/src/app.ts#L465-L565)、[线程 helper](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/src/utils/thread.ts#L1-L24)。

**【已确认事实】** 当前官方说明只有频道渲染可见线程；私聊、群聊、会议表现为平铺消息。异步保存 conversation ID 是官方建议，但 2.1.1 的 App.send 实际使用 `app.api.serviceUrl`（初始化默认公网 Teams 路由或显式 SERVICE_URL），并不会从任务中的历史 ref 自动恢复 service URL；当前 turn 的 API 则由入站 service URL clone。应保存受信 reply destination 的全部必要元数据并实测目标云/区域的异步路由，不把“仅存一个 ID”泛化成任意云都已验证。[官方 proactive 指南](https://microsoft.github.io/teams-sdk/typescript/essentials/sending-messages/proactive-messaging/)、[初始化 URL](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/src/app.ts#L230-L249)、[入站 ref](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/apps/src/app.process.ts#L166-L218)。

**【技术假设/建议】** handler 只完成输入验证、最小无敏感 ACK 与可靠入队；后台任务用受信 destination 发最终报告，不长期保留 ctx。任务隔离键至少包含租户、请求人、scope、会话/线程与任务 ID；以 `(tenant, conversation, activity.id)` 去重，队列重试使用 delivery key 防止重复回复。不能让模型或消息文本任意指定 conversation ID/service URL。Bot 必须已安装且有目标会话访问权；卸载、403、限流或目标消失时停止该交付并记录脱敏失败，不向其他群组兜底。[proactive 前提](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)。

## 4. 群组受众与披露授权

**【已确认事实】** Teams SDK 有 `api.conversations.getMemberById(conversationId, memberId)`、`getMembers(conversationId)`、`getPagedMembers(conversationId, pageSize?, continuationToken?)`。它们调用 Bot Connector `/v3/conversations/.../members` / `pagedMembers`，不是 Graph API；因此不能说“取 roster 一定要求 Graph Directory.Read.All”。官方要求 team/channel 用分页；chat 不支持分页，服务返回完整 roster。成员列表只是平台成员证据，不能证明谁有日志/index/repository 的读取权限。[客户端源码](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/api/src/clients/conversation/member.ts#L35-L61)、[公开便利方法](https://github.com/microsoft/teams.ts/blob/79ed749cb65c7f14bb9b1f94b8cfdc7b9c5a5b81/packages/api/src/clients/conversation/index.ts#L245-L264)、[官方 roster 说明](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/get-teams-context)。

**【已确认事实】** 若需 Graph 补足/核实实际受众，下列是不同的权限面；这些 API 返回成员，不返回其对业务日志和代码的权限。Graph 成员 ID 是 opaque，不能假设所有成员同租户。共享频道 `/allMembers` 包含直接与经共享 Team 间接加入、以及跨租户成员；不能仅检查 thread 发言者或 host Team 的直接成员。[聊天成员](https://learn.microsoft.com/en-us/graph/api/chat-list-members?view=graph-rest-1.0)、[频道 allMembers](https://learn.microsoft.com/en-us/graph/api/channel-list-allmembers?view=graph-rest-1.0)。

| 可选查询 | 当前文档权限 / 同意依赖 |
| --- | --- |
| `GET /chats/{id}/members` | delegated `Chat.ReadBasic`；app-only `ChatMember.Read.All`，也列出安装会话内 RSC `ChatMember.Read.Chat` 等选项 |
| `GET /teams/{id}/members` | delegated `TeamMember.Read.All`；app-only RSC `TeamMember.Read.Group` 或更广 `TeamMember.Read.All` |
| `GET /teams/{team}/channels/{channel}/allMembers` | delegated `ChannelMember.Read.All`；app-only RSC `ChannelMember.Read.Group` 或更广 `ChannelMember.Read.All` |

权限选择须按 endpoint 与 tenant policy 重新确认。广域 app-only 权限需要 admin consent；`TeamMember.Read.All` / `ChannelMember.Read.All` delegated 也要求管理员同意；`Chat.ReadBasic` delegated 在权限参考中不强制管理员同意，但租户策略仍可限制用户同意。RSC 在 manifest `authorization.permissions.resourceSpecific` 声明，经有权用户安装时对该资源授予，受管理员策略约束；不是“配置 manifest 就已经获得权限”。若业务授权还依赖 Entra 目录组，需另选相应目录 API/权限；本 POC 不预先申请广域 `Directory.Read.All`。[Team API 权限](https://learn.microsoft.com/en-us/graph/api/team-list-members?view=graph-rest-1.0)、[Graph 权限参考](https://learn.microsoft.com/en-us/graph/permissions-reference)、[RSC 授予与核实](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/grant-resource-specific-consent)。

**【技术假设/建议】** 将“工具调用授权”和“报告披露授权”拆为两次后端决定：先确认请求人可读取选定日志/仓库；输出前按报告涉及的全部资源及敏感级别，检查**可见该目标会话报告的全部受众**。保存成员快照时间、完整性、身份映射、授权策略版本及报告资源范围，发送前刷新；未知成员、外部身份、缺页、权限查询失败或成员变化均不当作允许。历史消息可能被未来加入者看到，因此实时 roster 本身无法证明永久安全；持久群报告还需对该会话及未来成员治理的明确披露规则，或改用逐次鉴权的链接。

**【技术假设/建议】** POC 可选择：①有明确披露策略、完整受众及一致资源授权的专用群，发送经输出校验的最小报告；②群里只发任务状态/受控链接，打开时按当前访问者鉴权；③改发已有且获授权的请求人私聊。群组无权限时也不回显资源名、日志片段、堆栈或泄漏原因。SDK 的 targeted/ephemeral API 可作为后续选项，因 preview 和客户端行为尚未验证，不作为本次敏感报告的唯一安全边界。

**【人工决策/POC阻断】** 明确谁维护群披露授权、允许哪些标准/私有/共享频道、是否允许 guest/federation、成员变化后如何处理既有报告、Graph/RSC 是否获批准。发送者权限、全体成员同属租户、Bot 已安装、RSC 已同意，都不能替代这些决定。

## 5. 独立 Adapter 契约文字草案

以下均为**【技术假设/建议】**，用于后续接口评审；不是已实现或已通过编译的 SDK 封装。只把平台模型翻译为本系统需要的值，不为此增加新服务、事件总线或额外 Agent Framework。

| 责任 / 契约 | 最小输入与输出 / 不变量 |
| --- | --- |
| `CommunicationAdapter` 入站订阅 | 输出 `InboundRequest`：事件 ID、规范身份引用及 assurance（服务已认证 / 用户 SSO 状态）、租户、会话 scope、会话/线程引用、对 Bot 的 mention、消息文本和接收时间。SDK raw Activity 不进入领域层；正文永远不是身份来源 |
| `IdentityResolver` | 把平台 sender 映射为规范主体；返回来源、验证时间、缺失/冲突。若使用 SSO，连接必须绑定同一租户与请求人，禁止“同名账号”匹配。token 留在基础设施层 |
| `AudienceResolver` | 按目的会话输出 `AudienceSnapshot`：主体集合、是否完整、证据来源、时间、版本；无法完整解析时显式 `unknown`，不返回伪空列表 |
| `ResourceAuthorizer` / `DisclosureAuthorizer` | 前者决定请求人是否能访问每项资源；后者决定报告能否披露给此 audience/destination。结果含允许/拒绝/未知、范围、策略版本、到期时间；unknown 按拒绝交付敏感内容处理 |
| `ReplyDestination` | 服务端生成 opaque 引用，内部保存 scope、租户、原会话、thread root、bot/cloud 与必要受信路由信息。只接受入站认证后捕获的引用或批准配置，模型不能构造它 |
| `sendReport(destinationRef, authorizedReport, deliveryKey)` | 必须有仍有效、绑定同一内容/资源范围和 destination/audience 的披露结论；发送成功返回 receipt/message ID；失败区分拒绝、目标失效、限流、暂时错误。异步发送前重新检查授权，不复用已过期的许可 |

Mock 实现使用固定合成用户/租户/资源与 fake clock，复用同一契约：模拟有效/无效身份、缺 tenant/oid、同名不同人、跨租户、未知 scope、只 mention 他人、重复消息、同时两用户同群请求、换线程、SSO 后续 turn、成员缺页/新增/移除、授权撤回、外部成员、队列重试、403/429/网络失败。断言拒绝路径不会调用业务工具或发送敏感内容、任务状态不串人/串群、delivery key 防重复、引用和审计无 token/原始敏感信息。Mock 不打开真实 HTTP 认证旁路来冒充“Teams 认证已验证”。

## 6. 后续应用注册、回调与运行验证

### 人工决定与批准后才进行的准备

- **【人工决策/POC阻断】** 指定隔离测试租户、测试应用、合成资源、测试人员/会话，以及注册/修改/发消息/读取成员的批准范围。应用创建与 Azure/Teams 管理操作不包含在本研究授权中。
- **【已确认事实】** 基础依赖包括 Entra 应用注册、Bot 注册、可从 Teams 访问的 HTTPS 消息回调、Teams app manifest/package 与允许安装的租户策略；本地可用受控 HTTPS tunnel，部署可用公开 HTTPS endpoint。后续配置 `/api/messages`，声明实际支持的 bot scopes，安装到对应测试会话，选择 client secret/managed identity/federation 凭据方式并以 secret store 管理。[注册依赖](https://microsoft.github.io/teams-sdk/get-started/quickstart-register/)、[认证方式](https://microsoft.github.io/teams-sdk/teams/app-authentication/)。
- **【已确认事实】** 需要 OAuth/SSO 时使用 Azure-managed Bot，Teams-managed Bot 不支持 OAuth connection。SSO 配置包括 AAD v2、`api://botid-<app-client-id>` URI、`access_as_user`、Teams 客户端预授权、Bot token service redirect URI、命名 OAuth connection、匹配的 tokenExchangeUrl，以及 manifest webApplicationInfo。Graph scopes 只选实际使用的最小权限；按测试云/区域选择回调域名。这里的 redirect 由 Bot token service 承接，不能与消息回调混为一条路由。[官方 SSO 配置清单](https://microsoft.github.io/teams-sdk/cli/guides/user-authentication-setup/)。
- **【技术假设/建议】** 多实例部署前提供共享状态存储、持久任务与 destination，避免把 OAuth pending state、去重及任务放在每个容器独立内存中；配置脱敏日志/审计、凭据轮换、健康检查。首次实施确认所有状态分区含适当租户、用户、会话/线程维度。

### 最小验证清单（全部【待安装/运行验证】，本研究未执行）

| 阶段 | 验收标准 |
| --- | --- |
| 无凭据 Mock | 上述身份/授权/隔离/注入边界测试通过；应用核心不依赖 Teams/Entra 凭据或网络 |
| 固定版本安装与编译 | 在获准的开发环境锁定 Node >=22.12 与包 2.1.1，typecheck/build 通过；验证 App、Activity、OAuthFlow、Graph 的实际编译接口及依赖许可证/安全检查 |
| HTTP 服务认证 | 缺失/伪造/错误 audience/issuer/过期 token/错误 service URL 被拒绝且不建任务；正确 Connector 请求通过；关闭 unauthenticated 开关与预认证 transport 注入面；错误租户/recipient 在后端拒绝 |
| 私聊 SSO | 首次同意、取消、token exchange、缓存 token、过期、sign-out、条件访问失败均符合预期；取得规范主体并对照平台 sender；不得记录 token；后续 sign-in turn 恢复正确原请求 |
| 群聊 mention | 只 mention Bot 才创建任务；mention 别人/不 mention/重复事件不误触发；首次 SSO 同意只作用于请求人，不暴露其凭据/资料；两人并发任务不混淆 |
| 频道线程 | 顶层触发与嵌套回复分别保存正确 root；当前 turn send/reply 与后台 app.reply 均在原线程；无频道 SSO时采用批准的私聊认证路径；不同频道类型各自验收，未测者明确不支持 |
| 异步与恢复 | 入队后回调及时完成；重启后能恢复原 destination；SDK configured serviceUrl 在目标区域正确；卸载/403/429/网络重试不重复泄露，不改投其他群；过期任务不继续发送 |
| 受众授权 | 实际成员查询完整；含 guest/共享频道间接成员；单一成员无资源权限、成员变化、查询缺页/失败、授权撤回时敏感交付被拒；受控链接每次打开重新授权；群历史可见性策略得到签收 |
| 最小权限 | 无额外 Graph 权限时 Connector roster 的实际可用范围；若需 Graph/RSC，最小权限成功、多余权限未申请、未同意时安全失败；管理员与资源所有者 consent 证据齐备 |

## 7. 实际完成的核验与未完成项

**已执行且通过：** 阅读研究票完整正文/状态/标签/负责人/评论；查验 Microsoft 官方文档、官方仓库 v2.1.1 tag/commit 与 release；读取 npm 四个包的 registry 元数据、下载公开 tarball 并核对 SHA-512；静态查看包声明中的 App.send/reply、OAuthFlow 与配置接口；对照固定源码检查 HTTP/JWT、mention、线程、会话成员与 OAuth 分支；检查研究 Markdown 的来源链接与状态分类。Context7 用于发现官方文档后再追溯第一方来源，未将聚合摘要作为最终事实依据。

**未执行：** 包安装、样例/SDK 执行、typecheck/build/行为测试、传递依赖审计、真实 token/回调/租户/客户端验证、Graph/目录查询、生产访问。**未进行：** 应用注册、租户/权限/凭据修改、读取公司 Teams 内容、发送 Teams 消息。静态证据足以选择 API 与设计验证边界；不把任何未实测项记为通过。
