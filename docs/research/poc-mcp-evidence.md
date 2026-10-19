# MCP 检索与 GitLab 多仓索引：可校验的 POC 证据

查验日期：2026-10-19。对应研究问题：[MCP 检索和 GitLab 多仓索引如何形成可校验的证据？](https://github.com/GordonFP/bau-support-agent/issues/4)。

本记录只做公开文档和固定源码静态研究；没有安装或运行 CBM，没有连接 Kibana、内部 GitLab 或生产环境，没有执行 MCP 探测、同步仓库或创建索引。文中的契约和流程是实施草案，静态源码检查不等于实际集成通过。

## 1. 研究结论与适用边界

- **【已确认事实】可以复用 CBM 的索引与跨仓匹配。** 最新正式发布为 **v0.12.1**，发布于 2026-10-16，固定源码为 `a7158ac2f48ca646b4527341b76f930f2aeff87e`。当前实际注册 **17 个工具**；原生支持图检索、源代码片段、文本检索、覆盖检查及跨仓 `CROSS_*` 关系，不应另写一套索引。[发布记录][release]、[工具注册][registry]、[跨仓源码][cross]
- **【已确认事实】原生只读 profile 可作为第一层约束。** `--tool-profile analysis` 实际允许 13 个只读工具，工具清单和调用分发均使用允许列表；该 profile 不运行初始化自动索引，不能启用 HTTP UI。它没有提供 Teams 用户、仓库 ACL 或报告受众授权。[profile][profile]、[分发][dispatch]、[初始化][initialize]、[入口][entry]
- **【已确认事实】原生元数据不足以单独证明每条证据对应当前远端 HEAD。** 索引保存 `Branch`/`HAS_BRANCH` 的 Git 上下文，但 `index_status(verbose=true).git` 是查询时重新读取本地 Git；代码片段也从当时磁盘上的文件读取。远端仓库标识、确认过的 main/master、同步校验、索引发布收据、跨仓版本组合仍需同步 Adapter 绑定。[Git 状态输出][gitstatus]、[索引中的分支][branch]、[片段读源][snippet]
- **【技术假设/建议】POC 采用管理窗口和冻结快照。** 管理面只读获取 2–3 个已授权 main/master 仓库，调用原生索引与跨仓能力；验证通过后发布一份带版本清单的快照。排障期间固定该快照，更新时暂停新查询并等待已有请求结束。先用这个简单流程验证一致性，不引入在线多版本编排。
- **【人工决策/POC阻断】实际 Kibana MCP 的实现、部署版本和工具契约未知。** 当前不能声称日志接入、权限下推、超时和返回量限制已兼容。可以完成 Mock 和代码侧 POC，但真实日志到代码的端到端验收仍被阻断；不得用网上任一同名服务器替代实际部署。

## 2. 来源与版本取证

**【已确认事实】** GitHub release API 查得 v0.12.1，固定 tag 的 Commit 如上。搜索引擎缓存仍显示 v0.11.0，固定版本 README 也残留旧版本说明及旧 profile 数量，因此本文以 release API、固定 Commit 的工具注册和调用路径为准。v0.12.1 发布说明要求现有项目首次索引做一次完整重建；升级不能直接假定旧图可用。[release][release]、[registry][registry]、[profile][profile]

**【已确认事实】** 主项目使用 MIT 许可证。原生发行支持 macOS、Linux、Windows 的 amd64/arm64；不需要 Node/Python 语言运行时执行原生 CBM。Linux 同时发布普通 ABI 版和静态 `-portable` 版，Docker 基础镜像必须匹配实际制品；release 说明普通 Linux 构建的 glibc 兼容问题，不能凭“Linux 支持”推定任意镜像均可运行。Git 元数据代码实际启动 `git`；部分检索路径还涉及系统工具，因此最小容器仍需按选定工具运行验证。[LICENSE][license]、[发行说明][release]、[README 平台说明][platform]、[Git 实现][gitctx]

**【待安装/运行验证】** 发布校验和、签名/构建来源、镜像 CPU/ABI、所需 Git/文本扫描命令、文件编码和路径行为均未实测。第三方库和内嵌模型有各自许可（如内嵌 Nomic 数据 Apache-2.0）；分发时依据实际制品保留声明，不能把顶层 MIT 等同于全部资产同一许可。[第三方声明][thirdparty]

**【待安装/运行验证】** 同一固定 Commit 的 README 宣称不主动联网，而 SECURITY.md 仍描述初始化后台更新检查，两者不一致。本次检查的 `initialize` 路径没有该更新检查调用，但这不足以证明整个制品无外联；生产候选镜像应默认限制 egress，在合成环境确认实际网络行为。[README 更新说明][updating]、[SECURITY.md][security]、[初始化源码][initialize]

MCP 协议按 **2025-11-25** 官方规范研究；CBM 固定源码同时列出 `2025-11-25`、`2025-06-18`、`2025-03-26`、`2024-11-05`。[支持版本][protocols]。GitLab 资料为 2026-10-19 的在线文档，尚未确认目标 Self-Managed 实例版本；API 支持范围和配置须在获得明确授权后逐项核对。

## 3. 实际工具契约及能力边界

以下是 **v0.12.1 固定源码事实**。完整输入 JSON Schema 以 [TOOLS 注册表][registry] 为准；表中只展开影响 POC 的必填参数和关键控制。所有项目名必须由服务器映射到已授权资源，不能由模型任意挑选。

| 实际工具 | 关键输入 | 实际结果及 POC 边界 |
|---|---|---|
| `search_graph` | 必填 `project`；`query` 或 `semantic_query`，名称/文件/label 过滤；`limit/offset`、`semantic_limit/semantic_offset`、`format` | 返回符号 qualified name、文件、行和图关联；语义搜索是参数，并不存在另一个 `semantic_search` 工具；只搜索已索引图。 |
| `search_code` | 必填 `project, pattern`；`mode=compact/full/files`、路径过滤、`regex`、多组 limit/offset、`source_max_lines`、`max_output_tokens` | 在已索引项目文件上作图增强文本搜索，有 raw/目录/符号分页及遗漏信息；会读取当前磁盘文件。 |
| `get_code_snippet` | 必填 `project, qualified_name`；`source_mode=auto/full/outline`、`start_line/max_lines`、输出预算 | 符号代码或容器 outline，可返回 ambiguous 建议及 coverage note；源代码来自当前本地文件，单次 `max_lines` 上限 500。 |
| `get_file_outline` | 必填 `project, file_path`；label 过滤、`limit/offset` | 一个确切相对路径的声明列表；不是通用任意文件读取接口。 |
| `trace_path` | 必填 `project, function_name`；方向、深度、`mode`、`edge_types`、cursor、`include_evidence` | calls/data_flow/cross_service/topology/deploy/run 静态路径；深度 1–15，默认不含测试；可以请求 resolver class/confidence，不等同运行时调用证明。 |
| `query_graph` | 必填 `project, query`；`graph=code/missed`、`max_rows`、cursor、输出预算 | 只读 Cypher 子集；默认显示 200 行，含截断/总量和延续信息。不是任意 SQL、Shell，也不是完整 Neo4j。写、`MERGE`、`CALL` 等不支持语法会报错。 |
| `get_graph_schema` | 必填 `project`；`diagnostics=none/full`、分页 | label/边类型计数，full 还列可查询属性；用于校验图查询契约。 |
| `get_architecture` | 必填 `project`；aspects、path、`expected_generation`、入口/目标节点 | 有界静态架构结果，也可能返回待完成的后台任务；行为信息是索引事实，不是完整数据流或运行时 trace。 |
| `compare_graphs` | 必填 `base_project, target_project`；`limit, scan_limit` | 两个**已经索引**快照的节点/边差异；不会替用户取历史 Commit 或构建历史索引。两个 project 都需授权。 |
| `list_projects` | 无必填；`detail=identity/stats`、分页 | 本 cache 的项目身份/统计；可能泄露其他项目名和本地 root，普通用户不应直接获得原始结果。 |
| `index_status` | 必填 `project`；`verbose`、`diagnostics`、`format` | `status/nodes/edges/root_path/indexed_at`、coverage、cross_repo、watch；verbose Git 上下文是实时本地状态。 |
| `check_index_coverage` | 必填 `project`；paths/scopes 及各自分页 | 覆盖和 freshness，`metadata_match` 是文件 size/mtime 比较，不是字节哈希相等证明；没有已记录缺口不能证明完整。[实现][coverage] |
| `detect_changes` | 必填 `project`；scope、方向、深度、`base_branch/since`、多组分页/cursor | 当前 Git diff 与图中受影响符号/测试；会读本地 Git。它不提供历史故障时已部署版本的自动恢复。 |
| `index_repository` | 必填 `repo_path`；`mode=full/moderate/fast/cross-repo-intelligence`、`target_projects`、`name`、`persistence`、`async/status` | **管理能力**：创建/更新索引，跨仓模式写图；`persistence=true` 还写仓库内 `.codebase-memory/graph.db.zst`。 |
| `delete_project` | 必填 `project` | **管理能力**：删除项目图及数据库文件。 |
| `manage_adr` | 必填 `project`；mode、content/section_updates | **写能力**：ADR CRUD；即使读取模式也可能迁移旧文件到存储，整个工具从数据面排除。 |
| `ingest_traces` | 必填 `project, traces`；label | **写能力**：累积观察调用次数，可能淘汰旧 run；重试不幂等，不提供给排障会话。 |

原生 profile `analysis` 包含表中前 13 个，拒绝后 4 个；`scout` 实际允许其中 8 个。`trace_call_path` 是分发兼容别名，注册名为 `trace_path`；analysis 允许列表按准确名称匹配，Adapter 应使用注册名。上游 README profile 数量存在滞后，以固定代码为准。[profile][profile]、[分发][dispatch]

**【已确认事实】输出没有稳定的官方 outputSchema。** 注册明确不声明 outputSchema：默认 `format=tree` 返回 text，`format=json` 的 JSON object 同时放入 `structuredContent` 和序列化 `content[].text`，错误 text 会封装 `{error: ...}` 并设置 `isError`。因此“支持 MCP”不能代替逐工具版本化解析；Adapter 应对支持的工具强制 JSON，按已验证字段验证，拒绝未知结构或状态，不把空 `{}` 视为成功。部分状态还需要检查 payload 的 `status/outcome`。[输出封装][output]、[schema 说明][outschema]

**【技术假设/建议】POC 最小允许列表**：符号/文本检索、代码片段、`trace_path`、schema、status、coverage；`query_graph` 先封装成服务器持有的有界查询模板。`list_projects` 留给 Adapter 做授权过滤；暂不开放 `detect_changes/compare_graphs`，除非用例确需。原生 analysis profile 是最大只读集合，应用可进一步收窄。工具 annotations 只表示上游声明，MCP 官方也要求不能把不可信 annotations 当授权保证。[MCP Tools][mcp-tools]

## 4. 多仓与跨仓：已支持什么，仍不能保证什么

**【已确认事实】** 每个仓库先成为同一 CBM store/cache 中独立 indexed project，再由管理面的 `index_repository(mode="cross-repo-intelligence", target_projects=[...])` 匹配跨项目关系。支持 `CROSS_HTTP_CALLS`、`CROSS_GRPC_CALLS`、`CROSS_GRAPHQL_CALLS`、`CROSS_TRPC_CALLS`、`CROSS_ASYNC_CALLS`、`CROSS_CHANNEL`。这是源码中的 route/call-site/topic/channel 匹配；不保证所有框架、动态路由、反射、配置注入和间接调用都可识别，不提供“2–3 仓所有调用关系完整覆盖”的承诺。[跨仓实现][cross]、[调用入口][cross-handler]

**【已确认事实】** 边属性可带 `target_project/target_function/target_file` 和 URL path/transport/method 等，但这里没有目标 Commit 的绑定；源和目标必须分别查询及记录版本。`index_status.cross_repo` 区分 `never_run` 和 `ran`，后者有 `last_run_at/outcome/targets/projects_scanned/total_cross_edges/skipped_projects`。`never_run` 不能解释为“跨仓无调用”；零边也不能解释为“运行时无依赖”。[边属性][cross-props]、[状态记录][cross-status]

**【已确认事实】跨仓构建是管理性多库写入。** 源和目标数据库均可被写，入口取得相关项目的 mutation leases，但取消不是多库事务回滚：已完成写入会保留，可能 `partial_results=true`。因此单仓原子发布不等于整个仓库集合的原子发布。显式列出 POC target_projects；不要用 `['*']` 扫到同 cache 的其他资源。通配模式还可能跳过旧 schema 项目。[跨仓 API 注释][cross-header]、[锁与返回状态][cross-handler]

**【技术假设/建议】** 把跨仓结果定义成“带来源的静态候选关联”。报告引用链为：脱敏日志事件 → 经确认的 service/repository 映射 → 来源仓库符号/行 → 候选 `CROSS_*` 边 → 目标仓库符号/行；每一端有独立 Commit/索引收据，保留 relation、resolver evidence 和 coverage/truncation 标记。匹配到同名路由不自动证明根因，缺少日志相关标识或配置映射时明确为待验证假设。

**【待安装/运行验证】** 以合成 A→B HTTP 和 B→C channel 例子，验证正例、同名路由误匹配、动态地址不识别、分页截断、目标未索引、取消及重跑。还要检查 `trace_path` 输出是否足以定位远端符号，不能只验证边计数变大。

## 5. GitLab 只读同步与版本证明

### 5.1 官方支持的只读获取路径

**【已确认事实】** `GET /projects/:id/repository/branches/:branch` 返回该分支的完整 `commit.id`。归档 API 支持以 `sha` 选择确切 Commit；repository files API 支持 ref 并返回 `commit_id/last_commit_id/blob_id/content_sha256`。注意 `last_commit_id` 是最后改变文件的 Commit，不是本次快照 Commit；非 UTF-8 内容可能先转换，`content_sha256` 不一定等于 clone 原始字节的哈希，精确字节校验应使用 raw endpoint 或 Git blob。[Branches API][gitlab-branches]、[Repositories API][gitlab-repos]、[Repository files API][gitlab-files]

**【已确认事实】** 项目 deploy token 的 `read_repository` 可 clone，但不能用于普通 GitLab REST API；不能把这个 token 直接拿去访问 branches/archive API。项目 access token 支持 Git-over-HTTPS 与 API，`read_repository` 和 `read_api` 范围不同；不得为了方便申请 `api` 写权限。项目 access token 的 Internal 可见性还存在官方提示的额外可达范围，服务端仍需准确项目允许列表。[Deploy tokens][deploy-token]、[项目 access token][project-token]、[scope 说明][token-scopes]

**【技术假设/建议】** POC 优先选每项目只读 Git 凭据，通过受控管理任务 fetch；使用 Git refs 验证远端分支 HEAD，无需额外 GitLab API 凭据。若选 API 归档路线，另确认支持该只读 API 的凭据与目标版本；归档通常没有 `.git`，CBM 原生 Git 上下文可能不可用，必须由 Adapter 保存已验证 Commit，不伪造 CBM 的 Branch 数据。两条路线二选一，勿无必要同时建设。

### 5.2 可复核的最小更新流程

以下整体为 **【技术假设/建议】**，不是已经运行的同步能力：

1. **固定授权资源**：管理配置为每仓库保存稳定 Repository ID、受批准 origin、明确 `main` 或 `master`、凭据引用；模型不能提供 remote、分支、文件路径根或 token。若 main/master 两者皆有，由人确认目标，不猜默认分支。
2. **读取远端 HEAD**：只读取该明确 ref，记录完整 Commit `H` 与 `headVerifiedAt`。Git 只 fetch 配置 ref，禁止 push；Git clone 的 `--single-branch/--branch` 和 fetch 显式 refspec 可限制本地获取范围，但 token 本身通常并非分支级权限。[git-clone][git-clone]、[git-fetch][git-fetch]
3. **形成冻结 checkout**：管理任务准备可丢弃工作目录，checkout 到 `H`（可为 detached）；核对 `rev-parse HEAD^{commit}` 等于 `H`、工作树/暂存区无修改、无额外可被索引的未跟踪/忽略源文件。限制 submodule/LFS/外部过滤器，未纳入批准范围的依赖不自动拉取，也不执行仓库构建或脚本。冻结后不在此目录继续 pull。[git-rev-parse][git-rev-parse]
4. **复用 CBM 索引**：在管理面调用 `index_repository`，模式/ignore/版本纳入收据。`persistence=false` 避免共享图写进业务仓库；不自动导入业务仓库提供的预构建图作为可信证据。静态源码说明 artifact 内容并不自动校验为真实源码图。[索引输入][registry]、[artifact 信任说明][artifact]
5. **校验发布结果**：必须成功终态、无 degraded/partial/未知 metadata，读取 `index_status` 和 coverage；通过受控 `query_graph` 读取已存 `Branch.head_sha`（存在 Git 时）与 `H` 比较。CBM 名称→Repository 映射和可信同步记录均一致才接纳。以合成 repo 校验实际查询字段后固定模板。[Branch 写入][branch]
6. **构建跨仓关系**：全部 2–3 仓成功后，在管理面执行跨仓模式，明确 target list；核对 `outcome=complete`、实际项目数及 skipped/partial 状态，并再次绑定每仓库 Commit/索引版本。失败时整个新集合不投入排障服务。
7. **发布收据**：保存应用生成的 `snapshotId`、每仓 Repository/Branch/Commit、`headVerifiedAt/syncedAt/indexCompletedAt`、CBM 版本/制品哈希、原生 `indexed_at`、可得 generation、项目 DB 哈希、模式/ignore 配置版本及跨仓结果。`indexed_at` 不代替唯一快照 ID。保留最后成功快照及最后失败更新记录。
8. **接纳查询**：查询开始固定同一 snapshotId，并覆盖一次排障的所有证据调用。最简 POC 在管理窗口停止接纳新查询、等待读请求结束、完成更新和校验后再放行；排障侧源目录与索引文件只读。若需要不停机更新，再单独决策快照切换方案。

每个检索结果由 Adapter 加上同一快照的 Repository、确认的 Branch、Commit、原生索引时间、收据引用、文件/行、符号和必要的内容哈希。链接用固定 Commit 的代码行 URL，避免可变 main/master 链接。路径和本地 root 不直接返回给用户。

### 5.3 一致性与过期处理

**【已确认事实】** 单仓索引有 staging、完整性检查、generation 更新与原子发布路径；资源限制触发时不把半张图当完整图发布，并尽量保留已有索引。查询文件 store 在请求结束关闭，避免长期持有旧 generation。然而不同工具调用可能看到不同次发布，片段读取本地文件也不被数据库 read transaction 冻结。[发布流程][publish]、[请求范围 store][request-store]、[资源限制][limits]、[片段读取][snippet]

**【已确认事实】** 自动 watch 不是远端 GitLab 同步器。README 说明自动同步只跟随打开的 MCP 会话项目，其他 CLI 索引仓库需重跑；profile analysis 初始化不会启动索引。`index_status=ready` 主要表示节点数可读且大于零，不等于已与远端 HEAD 相同。[索引及 watch 说明][index-doc]、[status 实现][status]、[初始化][initialize]

**【技术假设/建议】** 同步失败、远端不可达、HEAD 已变、索引与 checkout 不同、跨仓未完成、coverage metadata 不明分别记录。当前证据可标为 `verified_at_check/stale/unknown/mismatch`；“已校验”只指 `headVerifiedAt` 时刻，无法承诺之后远端永不变化。时间 TTL 和允许多旧的证据必须由 POC 负责人确定，不能自行把“24 小时”等阈值写成既定验收。mismatch 拒绝输出为当前代码证据；旧快照如获准使用，报告明确 Commit/校验时间/滞后和未覆盖范围，不自动静默降级。

**【技术假设/建议】历史版本局限**：仅分析 main/master，不能证明历史故障时部署的就是该 Commit。按已确认范围，POC 不建设完整部署版本映射；报告应明确“当前分支候选代码”，必要时由人核对当时的运行版本。若某条根因结论依赖历史运行代码且无法核实，只限制该条结论的确定性，不将完整映射列为整个 POC 的进入条件。`detect_changes` 和 `compare_graphs` 不能弥补这一证据缺口。

## 6. 管理面、只读数据面与身份隔离

**【已确认事实】** CBM 以 stdio 作为 MCP 入口，前端连接每 OS 账号共享的协调 daemon；不是独立按 Teams 用户运行的授权服务器。cache 路径、首次启动 daemon 捕获的资源环境和具体 build admission 有进程级影响。只换前端 session 或设另一个 CBM_CACHE_DIR 不能推定获得同账号多租户隔离。[daemon 说明][daemon]、[配置说明][config]、[MCP 入口][entry]

**【技术假设/建议】**

- **管理面**：独立 OS identity/容器/凭据，持有 GitLab 只读同步凭据及 CBM 的索引写权限；只暴露给受控运维作业，生产排障模型没有该连接、API 或任意 Shell 能力。
- **数据面**：独立 identity/容器启动固定制品 `--tool-profile analysis`，禁 UI、hook/自动索引与网络下载；仓库快照和项目 DB 只读挂载，私有 runtime/socket/log 目录单独可写。源码存在只读 SQLite 打开与只读文件系统 fallback，但实际 cache layout、权限和所有工具还需容器验证。[只读 store][readonly-store]
- **调用前授权**：可信服务端从已验证身份及会话生成授权上下文，检查精确 tool、Repository、快照及受众；模型参数不能创建/修改 principal、role、tenant、resource scope。跨仓路径要求对每个端点和关联资源授权；只过滤最终文本不足以阻止模型先看到无权数据。
- **物理资源集合**：一个数据面 cache 只放该授权资源集合可见的项目。对不同 ACL 集合使用独立进程/资源隔离，或在底层可验证地实施等效授权；不能共享一个全库 daemon 后仅在展示层隐藏项目名。`CBM_ALLOWED_ROOT` 主要限制索引路径及 UI 索引入口，不能当项目 ACL。[配置][config]
- **连接与缓存**：按可信 authorization scope、credential binding 和 snapshot 维护连接；若用户凭据不同，不复用同一 token provider/HTTP session。会话状态、模型上下文、任务缓存和 audit 仍按用户与排障会话隔离；同一只读公共资源进程不代表可复用上次调用人的权限。
- **防泄漏**：凭据仅留在管理面/密钥存储，不能放 tool arguments、源码收据、报告或 prompt。工具结果先限量、校验、脱敏，再进入模型；日志/代码文字中的指令当数据，不能扩展 allowlist。审计存调用人/会话引用、授权结果、资源别名、tool、耗时、结果码和证据版本，审计本身脱敏。

数据面不能使用 `manage_adr(mode=get)` 来规避禁写：源码读路径可能迁移遗留 ADR。只读也不意味着没有 CPU、内存或子进程消耗，`search_code/detect_changes` 等在服务内部可能运行受控系统命令；生产模型不能因此获得通用 Shell。[ADR 源码][adr]、[只读工具集合][profile]

## 7. MCP transport、生命周期与资源契约

**【已确认事实】** MCP 2025-11-25 定义 stdio 与 Streamable HTTP；stdio 由 client 启动子进程，stdout 专用于 JSON-RPC。CBM 的可选 loopback HTTP UI 是管理/可视化界面，不能直接当 Streamable HTTP MCP endpoint 使用。Kibana 实际 transport 未知。[MCP transport][mcp-transport]、[CBM 入口][entry]

**【技术假设/建议】连接管理封装**：创建 transport → initialize/协商版本和 capabilities → initialized → 校验批准的 serverInfo/schema 指纹 → 只注册经过审查的工具 → 每次调用前授权 → deadline/取消 → 关闭 transport/回收所属子进程。Pi/Teams 业务用例只依赖 Adapter；不能在排障请求里动态安装 CBM、执行安装脚本或改变 MCP 配置。[生命周期规范][mcp-lifecycle]

**【已确认事实】** HTTP 如返回 MCP-Session-Id，后续请求需携带；失效后的 404 需要重新初始化。session ID 是关联状态，不能当授权。HTTP 每个请求均需正确凭据，OAuth token 应绑定相应服务 audience，不能把 Teams/GitLab token 透传给另一服务。[transport][mcp-transport]、[authorization][mcp-auth]、[安全规范][mcp-security]

**【技术假设/建议】资源策略**：服务端设置工具/查询总 deadline、单页结果数、最大页数、输出字节、代码行、搜索范围、并发与速率上限，并在进模型前再次截断/脱敏。query_graph 显示行数限制不保证计算便宜；只用有界模板、深度和可取消调用。CBM 的 `max_output_tokens` 是每 token 4 UTF-8 字节的确定性预算，不是实际模型 tokenizer 精确计数。[工具输入][registry]

**【已确认事实】** 索引 `index_max_files/index_max_source_mb` 默认关闭，需管理配置；不能取代容器 CPU/RAM/disk/pid 限制。它们不影响跨仓模式。`CBM_WORKERS/CBM_MEM_BUDGET_MB` 及 daemon 环境由启动方式影响，必须在固定部署中验证。[资源限制][limits]、[配置][config]

**【待安装/运行验证】** 断连不应无条件重试或重放；先区别 JSON-RPC 错误、tool `isError`、payload 失败/partial、timeout、取消、401/403/429 和进程崩溃。只读幂等请求可在同身份、同快照下有限重试；401/403 不自动扩大 scope。同步索引可能超过单次 deadline；原生 async 作业要 daemon 保持存活，`async/status` 互斥且跨仓模式不支持 async，均限管理面。[索引作业说明][index-doc]

## 8. Kibana：必须取得的实际契约与阻断影响

**【人工决策/POC阻断】** 目前没有实际服务器实现、发布/镜像版本、schema 或脱敏返回样本的可信记录。本研究没有调用 Kibana 工具，包括 `tools/list`。后续只能由维护者提供经过批准的非敏感元数据和合成样本；不能从本机工具名称或网上 Elasticsearch/Kibana MCP 项目推定部署契约。

| 待确认资料 | 缺失时不能验收的能力 |
|---|---|
| 实际维护者、版本/Commit/镜像 digest、准确工具名及 inputSchema/outputSchema、只读或写能力 | 无法冻结 allowlist 和版本解析器；不能确认“执行查询”是否会允许任意 API 或变更操作。 |
| stdio / Streamable HTTP / legacy SSE，初始化版本与 capabilities、连接/关闭/失效行为 | 无法验收 transport 和重连兼容性。 |
| 认证方式、可信用户到凭据/角色映射、scope、tenant 与资源授权规则、凭据轮换 | 无法验收用户/会话隔离和最小权限。 |
| 允许数据源的授权别名、索引/字段范围、时间字段与时区、查询语言（KQL/DSL/ES\|QL 或其他）、必需过滤 | 无法保证查的是获准资源、正确时间范围和可映射服务。不得自行探测索引。 |
| 最大时间窗、lookback、行数/字节/页数、分页顺序与游标、聚合及超时/partial 语义 | 无法保证有界调用，也不能把零结果、截断或 partial 当完整证据。 |
| 错误模型与状态码、超时/取消、429、鉴权失败、节点故障、数据不可达 | 无法验收失败降级和重试策略。 |
| 脱敏字段策略、事件稳定定位符、query 时间窗、fetchedAt、可重现的证据引用 | 无法提供日志到代码可校验关联和安全报告。 |

**【技术假设/建议】** 获得上述契约前，实现 `LogEvidencePort` 的 Mock 及合成事件；对真实 Adapter 保持 `contract_unverified` 状态，拒绝生产调用。真实接入批准还必须明确资源、主体、允许工具、动作与时间范围；POC 资源清单不是访问批准。

## 9. 只读 Tool Adapter / Mock 契约草案

以下 **【技术假设/建议】** 是供后续 TypeScript 实施评审的应用边界；不是官方 MCP SDK 类型，也未提交实现。`ctx` 只能由可信服务端创建，领域层不依赖 MCP、GitLab、Teams 或 Pi 类型。

```ts
type Freshness = "verified_at_check" | "stale" | "unknown" | "mismatch";
type FailureCode =
  | "denied" | "contract_unverified" | "schema_mismatch"
  | "unavailable" | "timeout" | "cancelled" | "rate_limited"
  | "stale_evidence" | "version_mismatch" | "partial_evidence";

type ReadContext = Readonly<{
  principalRef: string;       // 服务端已验证身份的引用，不由模型声明
  sessionRef: string;
  authorizationRef: string;  // 由服务端解析资源/受众授权
  snapshotId: string;        // 一次排障固定的已接纳快照
}>;

type CodeVersion = Readonly<{
  repositoryRef: string;     // 授权别名，映射在 Adapter 内
  branch: "main" | "master";
  commit: string;
  indexedAt: string;         // CBM 原生字段
  indexCompletedAt: string;  // 管理收据时间
  headVerifiedAt: string;
  snapshotId: string;
  receiptRef: string;
  cbmVersion: string;
  generation?: string;      // 仅在该工具/版本实际返回并验证时填写
  freshness: Freshness;
}>;

type CodeEvidence = Readonly<{
  version: CodeVersion;
  path: string; startLine: number; endLine: number;
  qualifiedName?: string; snippet?: string; contentSha256?: string;
  coverage: "no_recorded_gap" | "gap" | "unknown";
  relation?: string; resolverEvidence?: string;
}>;

type ReadResult<T> =
  | { ok: true; value: T; truncated: boolean; nextCursor?: string;
      warnings: readonly string[]; auditRef: string }
  | { ok: false; code: FailureCode; retryable: boolean; auditRef: string };

interface CodeEvidencePort {
  search(ctx: ReadContext,
    req: { repositoryRef: string; text: string; limit: number; cursor?: string },
    signal: AbortSignal): Promise<ReadResult<readonly CodeEvidence[]>>;
  snippet(ctx: ReadContext,
    req: { repositoryRef: string; qualifiedName: string; maxLines: number },
    signal: AbortSignal): Promise<ReadResult<CodeEvidence>>;
  trace(ctx: ReadContext,
    req: { repositoryRef: string; qualifiedName: string; depth: number },
    signal: AbortSignal): Promise<ReadResult<readonly CodeEvidence[]>>;
}

interface LogEvidencePort {
  search(ctx: ReadContext,
    req: { sourceRef: string; from: string; to: string;
           correlationRef: string; limit: number },
    signal: AbortSignal): Promise<ReadResult<readonly {
      evidenceRef: string; sourceRef: string; occurredAt: string;
      fetchedAt: string; redactedMessage: string; queryWindowRef: string;
      serviceRef?: string; deploymentCommit?: string;
    }[]>>;
}
```

约束：请求对象不提供任意 MCP tool name、origin、repo_path、Shell、SQL、索引管理或 credential 字段；若需要自由文本日志查询，由维护者确认语言后增加受限结构。代码跨仓 trace 的每一行必须重新解析实际 repositoryRef 并授权，不能继承起点授权。外部 cursor 由 Adapter 绑定身份、参数、资源和 snapshot，不让模型修改内部 scope。返回 unknown/mismatch 不能被补成 verified；超过限制、缺口、跨仓 partial 或版本不可知时保留失败/警告语义，不改写为“未找到问题”。

Mock 使用同一 Port，预置资源别名 A/B/C、合成 Commit/快照、脱敏事件和图结果；不包含真实 endpoint、人员、租户、索引名或生产日志。至少覆盖：授权前零调用、A 无权访问 B、并发会话交错、凭据/会话绑定、日志注入文本、脱敏前阻止进入模型、schema 漂移、时间窗/量上限、分页改变快照、HEAD mismatch、陈旧/未知索引、跨仓 partial、取消/超时/429/401/403、无日志结果与日志源不可达的区别。

## 10. 最小运行验证及完成判据

所有项目均为 **【待安装/运行验证】**。仅在后续明确批准后，先用固定制品和合成环境执行；本研究不把它们记为已通过。

| 验证 | 最小通过证据 |
|---|---|
| 制品/容器 | 固定 v0.12.1 校验和与来源；目标 CPU/ABI 启动成功；Git 和被使用的检索命令存在；egress/文件访问范围符合配置。 |
| MCP 生命周期/工具 | stdio initialize/initialized、协议版本、分页工具清单与固定 schema 相符；analysis 直接调用 4 个写工具及别名绕过均被拒绝；无自动索引/UI/安装行为。 |
| 2–3 合成仓同步 | 分别 main/master，明确 ref；远端 H、checkout H、存储 Branch H、快照收据一致；拒绝脏工作树/额外文件/未批准 repo；更新只从管理面运行。 |
| 图与文件一致 | 固定快照上检索→片段→路径行对应原始字节；变更 HEAD/文件后拒绝旧证据；不能仅凭 metadata_match 或 ready 通过。 |
| 跨仓关系 | A→B HTTP、B→C channel 的端点、源码行和双端 Commit 可复核；同名/动态路由不误报为确定调用；无授权端点不进入模型。 |
| 更新/故障 | 更新中阻止新快照查询，已有读完成；索引取消、资源超限、OOM/崩溃、disk full、跨仓中断、旧 schema skipped 不发布混合/半完成新集合；旧集合状态明确。 |
| 只读部署 | 管理/数据面不同身份与凭据；项目 DB/源文件只读、runtime 私有；损坏图读取不自行修复/重建；无权限读其他 cache/源码/密钥。 |
| 用户并发与审计 | 不同用户/会话交错调用不共享授权状态、凭据或模型缓存；每次调用有脱敏 auditRef 和版本收据；群组报告按受众校验。 |
| Kibana Mock | 使用维护者确认 schema 的合成 server；时间窗、返回量、partial、超时、权限拒绝、注入/脱敏与错误分支可验证。实际契约未取得时此项不可冒充真实联调。 |
| 真实日志到代码 | 实际 Kibana 契约确认、适用授权到位后，才在批准范围验证；报告注明当前 main/master 的版本口径，历史运行版本必要时人工核对，不要求建设完整映射。当前因契约和授权未落实而阻断，未执行。 |

研究完成不等于 POC 已 Go：当前静态证据足以规划 Mock/合成仓验证；真实 Kibana 契约、资源授权与运行验证仍是显式前置条件。历史运行版本的不确定性按报告局限和必要的人工核对处理。

## 11. 本次实际执行的验证

- 已读取研究票的完整正文、状态、标签、负责人及评论；只读取项目约束，没有改动项目工作区或 Git refs。
- 已用 GitHub 第一方 release/tag API 查验版本，下载固定 Commit 的公开文本源码到临时目录静态检查；没有执行所下载代码。
- 已从固定 C 字符串解析实际 inputSchema，确认 17 个注册名、required 字段及 profile allowlist；检查调用分发、输出封装、Git 元数据、代码片段来源、跨仓写入与取消、发布和只读 store 路径。
- 已读取 GitLab、Git 和 MCP 官方资料；以公开链接记录证据。未调用任何 Kibana、生产或内部 GitLab 工具，未安装依赖，未创建索引。
- 未执行：二进制运行、Docker/SDK 联调、行为测试、真实权限/性能测试。原因是本票限定静态研究且生产批准/实际 Kibana 契约未提供；这些项目均列为待验证/阻断。

## 官方来源

以下 CBM 链接均固定到 `a7158ac2f48ca646b4527341b76f930f2aeff87e`；行号以该版本静态源码核对。MCP 链接固定协议日期，GitLab/Git 在线文档已在查验日读取。

[release]: https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.12.1
[registry]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/mcp/mcp.c#L533-L874
[profile]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/mcp/mcp.c#L898-L1047
[dispatch]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/mcp/mcp.c#L20486-L20552
[initialize]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/mcp/mcp.c#L20934-L20939
[entry]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/main.c#L3375-L3420
[gitstatus]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/mcp/mcp.c#L2719-L2741
[branch]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/pipeline/pipeline.c#L1581-L1600
[snippet]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/mcp/mcp.c#L12909-L12924
[license]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/LICENSE
[thirdparty]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/THIRD_PARTY.md
[platform]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/README.md#L451-L463
[gitctx]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/git/git_context.c#L47-L110
[updating]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/README.md#L259-L279
[security]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/SECURITY.md#L13-L36
[protocols]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/mcp/mcp.c#L1431-L1440
[output]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/mcp/mcp.c#L390-L443
[outschema]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/mcp/mcp.c#L942-L965
[cross]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/pipeline/pass_cross_repo.c#L1413-L1599
[cross-header]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/pipeline/pass_cross_repo.h#L46-L65
[cross-handler]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/mcp/mcp.c#L10554-L10760
[cross-props]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/pipeline/pass_cross_repo.c#L231-L250
[cross-status]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/pipeline/pass_cross_repo.c#L1316-L1392
[artifact]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/mcp/mcp.c#L10763-L10784
[publish]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/pipeline/pipeline.c#L3456-L3486
[request-store]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/mcp/mcp.c#L20573-L20637
[coverage]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/mcp/mcp.c#L6896-L6942
[status]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/mcp/mcp.c#L7380-L7475
[index-doc]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/README.md#L825-L862
[limits]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/docs/INDEX_RESOURCE_LIMITS.md
[daemon]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/README.md#L141-L161
[config]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/README.md#L911-L956
[readonly-store]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/store/store.c#L1110-L1161
[adr]: https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/mcp/mcp.c#L20099-L20147
[gitlab-branches]: https://docs.gitlab.com/api/branches/#retrieve-a-repository-branch
[gitlab-repos]: https://docs.gitlab.com/api/repositories/#retrieve-file-archive-from-a-repository
[gitlab-files]: https://docs.gitlab.com/api/repository_files/#get-file-from-repository
[deploy-token]: https://docs.gitlab.com/user/project/deploy_tokens/#gitlab-public-api
[project-token]: https://docs.gitlab.com/user/project/settings/project_access_tokens/
[token-scopes]: https://docs.gitlab.com/security/tokens/access_token_scopes/
[git-clone]: https://git-scm.com/docs/git-clone
[git-fetch]: https://git-scm.com/docs/git-fetch
[git-rev-parse]: https://git-scm.com/docs/git-rev-parse
[mcp-transport]: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
[mcp-lifecycle]: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
[mcp-auth]: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
[mcp-security]: https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices
[mcp-tools]: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
