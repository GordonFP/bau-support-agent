# #22 独立 MCP Client 与本地合成取证

实现 [#22](https://github.com/GordonFP/bau-support-agent/issues/22)，沿用父规格 #14 的 A–D 公开测试边界。集成基线为 `918c38c`；合并两项共享依赖提交及审计元数据提交后，本票基于 `ecc1722`。交付前合并 `codex/poc-integration`，结果 already up to date。实际验证日期为 2026-10-20 UTC／2026-10-21 新加坡时间。

## 实现与边界

- `mcpEvidencePorts` 装配现有 `LogEvidence.read`／`CodeEvidence.search`，实际独立 MCP `Client` 读取本地合成 SDK Server，Mock Agent／模型完成 Simulator 报告。应用与领域不依赖 MCP 类型；没有增加 Agent 工具操作或更改 A–D 方法。
- 本票只启用 stdio 合成契约 `synthetic-evidence-1`：`read_logs`、`search_code`，固定 server、协议 `2025-11-25`、名称／描述／输入 schema／版本／manifest SHA-256，启动前检查宿主配置的本地服务制品 SHA-256。真实 Kibana／Codebase Memory 的原生契约、制品和权限由后续票验证，本票没有声称它们已兼容。
- 每次初始化、清单读取、工具／分页调用及结果释放均重新检查当前主体、来源代号、冻结快照、phase、取消与绝对 deadline。只接受批准的 Simulator 来源、24 小时区间、100 条页大小；跨页／轮次累计限制 500 条、七天。未知参数、端点、DSL、仓库、路径、快照、管理／枚举工具及清单漂移默认拒绝。
- 复用 SDK 的公开 `Transport`、`ReadBuffer`、`serializeMessage` 和协议 schema；没有复制 JSON-RPC parser 或读取 SDK 私有字段。每个宿主逻辑调用独占连接，初始化、清单、全部页、progress、错误与空白／Unicode 转义共用接收计数。收到 Buffer 后、UTF-8 转换／JSON 解析前限制实际累计 1 MiB，另校验 framing 与严格 UTF-8。跨页／通知不会重置额度；stdio 无压缩层，计量即其 UTF-8 线协议字节。未实现 HTTP／SSE／解压接收，相关 transport 配置不启用；没有把本次 stdio 结果记为 HTTP 验证。
- 单条安全证据包含不可信来源标签后最多 16 KiB；其他安全字符串亦限量。案件累计 256 KiB 保守计入完整安全结果页的观察、元数据、警告和标签，日志／代码及新 phase 共用额度；既有完整模型输入 24k gate 继续执行。
- 严格 Zod DTO 覆盖 structuredContent；本契约只接受空 content，拒绝任意文本块、嵌入资源、附件、details／meta 等其他通道。progress 先经 SDK schema、严格字段和当前 token 验证，再净化并丢弃；错误与 stderr 不转发、不记录正文。不能安全处理的片段拒绝。授权、manifest、输出与目的会话均不由工具内容决定，恶意指令作为带标签的不可信证据。
- 客户多申请使用本案受控内存 alias→原值映射；仅从当前授权且客户／申请匹配的来源结果学习，在结果审计及最终检查成功后同步接纳。最多 100 项、每个原值 1024 字节、代号 128 字节、合计 64 KiB；拒绝碰撞、重绑和跨案代号。补问后保持同案绑定，终态／取消／保留到期清理，不向模型、记录或 source receipt 写原值。
- 每个外部逻辑动作先可靠意图审计，再调用；结果审计保留有限结果、完整性、截断和数量。新增经过闭合字段／值校验的工具与模型版本元数据；实际 manifest／schema／制品／净化管线引用与 call ID 关联，不复制完整 manifest、端点或正文。内层审计失败会触发现有故障边界，仅允许固定无调查内容通知，且不重试失败的审计。
- 完整性以各页和证据中较保守状态合并，截断取并集；警告进入安全工具记录及报告局限，包括零命中。取消、旧 phase、接收限量或晚到协议错误不能发布新证据／绑定。每案最多两个连接、全局上限为 32 案 × 2，无无界等待队列；owned child 使用 shell:false、最小环境、独立进程组和有限 stderr。终止先 TERM，再 KILL；保留原始未结束工作及实际子进程关闭确认。Retention 共用既有五秒收尾，未确认结束的审计／运行清理保持 partial。

## 固定依赖与实际 API

精确版本、传递锁图、SHA-512、MIT 许可证、安全公告与 npm audit 记录见 [共享协议依赖](protocol-dependencies.md)。本票使用 `@modelcontextprotocol/sdk@1.32.1`（固定源码 `ff07b001194fe60ee9deb2121cf119057565796d`）和 `zod@4.6.7`；未更改锁定版本。使用 SDK `Client.connect/listTools/callTool/close`、`onprogress`、`resetTimeoutOnProgress:false`、`maxTotalTimeout`、public Transport／ReadBuffer／ProgressNotificationSchema。通过本地服务实际运行上述类型与协议，而非仅检查方法名。

官方依据：[固定 Client](https://github.com/modelcontextprotocol/typescript-sdk/blob/ff07b001194fe60ee9deb2121cf119057565796d/src/client/index.ts)、[固定 Transport](https://github.com/modelcontextprotocol/typescript-sdk/blob/ff07b001194fe60ee9deb2121cf119057565796d/src/shared/transport.ts)、[固定 stdio parser](https://github.com/modelcontextprotocol/typescript-sdk/blob/ff07b001194fe60ee9deb2121cf119057565796d/src/shared/stdio.ts)。公开 API probe 发现单独使用 `StdioClientTransport.maxBufferSize` 无法限制多条 progress 的实际累计接收；因此只替换有界 transport，仍复用 SDK Client／parser。SDK Ajv provider 的可选公开声明 import 在严格 NodeNext 下出现 TS2709；使用已经锁定且直接声明的 Zod 闭合 DTO，保留 `skipLibCheck:false`，不增加 any shim。SDK listTools 会提前缓存 outputSchema validator，因此还通过公开 jsonSchemaValidator 入口拒绝本合成 manifest 之外的任何上游 outputSchema，避免在清单比对前编译不可信 schema。

冻结源文件 SHA-256：

```text
manifest.ts: 7cbe966a59ca2405caf45a29cff77e5a79da2b82a1d089b08538d29f100f73c1
mcp-service.ts: fc6f80992ea37f1382ec7dacbf5b2c600ce57810a8bdd79ce988d1deeb3a90d5
compiled mcp-service.js: f4854ae226e402aaa10ea1dbe8d5916fa211b5de441ff1c92ac7b9b7cb0bce5f
```

测试使用显式合成服务制品摘要；修改摘要会在子进程启动前失败。测试服务的可选独立 receipt 只写 `started`、`tools/list` 和工具名，用来验证实际零调用／单次调用，不写参数、身份或正文；临时目录在测试结束删除。

## 验证

使用 Node 24.22.0、TypeScript 7.0.2、@types/node 24.10.0，完整严格类型检查与构建通过。TDD 实测发现并修复：来源标签字节遗漏、结构化观察未计累计、SDK 吞掉 progress 回调异常／schema 错误、非致命 UTF-8 替换、补问代号无法反解、取消后异步初始化、内层审计故障未锁定，以及保留清理尚未确认的运行工作。

- macOS arm64：全部 224 项行为测试通过，包括本票实际 MCP 客户端／服务、A→B→Mock 模型→D 报告和 C 导出。
- Linux arm64：同一编译产物全部 224 项行为测试通过，网络关闭、只读代码／根目录、临时可写目录、512 MiB／pids=64；保持 #20 已验证的测试文件并行度 2，用例内部并发仍执行。
- 验证涵盖精确 1 MiB 与超一字节、空白／Unicode 转义／分页累计、严格 UTF-8／JSON／schema、progress／注入／资源／异常、16 KiB／256 KiB、当前授权／跨案／快照／路径／制品漂移、补问映射、取消／deadline、晚到尾流、未确认清理及记录／报告原值扫描。独立 source receipt 证实拒绝及意图审计失败为零实际进程启动，获准调用仅一次实际工具请求。
- `git diff --check`、交付文档本地引用与记录的源文件摘要检查通过。

```sh
export PATH=/tmp/node-v24.22.0-darwin-arm64/bin:$PATH
npm run typecheck
npm run build
node --test dist/tests/behavior/*.test.js

docker run --rm --pull=never --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m --memory=512m --pids-limit=64 \
  --mount type=bind,source=/tmp/bau-spec14-worktrees/issue-22,target=/app,readonly \
  --workdir=/app \
  node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 \
  node --test --test-concurrency=2 dist/tests/behavior/*.test.js
```

尚未执行／不在本票声明通过：HTTP／SSE／gzip／OAuth／自动重连、真实 Kibana／CBM 软件及底层 ACL、真实 Pi 会话、模型、Teams 租户、生产／GitLab 访问和收费验证。独立本地进程、工具名、readonly 注解或合成通过都不证明生产凭据的只读权限。#15 所记 Node 安全更新核验及分发 notices／签名信任链仍由后续启用／镜像门禁处理；没有声称完成这些项。本地协议通过不关闭真实联调票或父规格 #14。

## 评审修订：实际日历日期

规格评审在 `e1b2f5e` 通过公开本地 MCP → 应用 → 报告复现：`submittedOn`／`completeThrough` 只校验字符串形状，`2026-99-99`、四月三十一日和非闰年二月二十九日仍可被写成已验证完整覆盖。先增加实际协议回归观察到完成报告，再将日期字段改为精确锁定 Zod 的 `z.iso.date()`，不新增自制日期解析器。无效值现在以 `schema_mismatch` 拒绝，模型、证据保留和报告交付均为零。

既有 `z.iso.datetime()` 已含 Gregorian 日历校验；原生 MCP 回归确认 observation／acquisition／index 时间及候选申请时间拒绝不存在日期。日志查询窗口此前使用 Date.parse，也会把非法二月二十九日归一化；现复用同一严格 datetime 校验，在实际来源进程启动前以 `invalid_request` 拒绝。2024／2000 年二月二十九日仍可完成报告，1900 年不被当成闰年，覆盖日期 null 仍为 unknown。

精确 Node 24.22.0 下类型检查、构建、全部 224 项 macOS 测试及相同受限 Linux arm64 环境的 224 项测试通过；本次新增 9 项公开行为测试，包含逐字段原生协议、A／C／D 出口与独立来源 receipt。差异、文档引用和更新后的合成服务制品摘要检查通过。合并最新集成 `e1b2f5e`，结果 already up to date。没有访问真实服务或关闭 Issue。
