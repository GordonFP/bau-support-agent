# #25／#26 共用 MCP 边界检查点

此提交只完成两个实际来源 Adapter 所需的共用边界，并让既有 #22 合成 Adapter 实际使用它。没有实现或验收 Kibana／Codebase Memory 接入，不关闭 #25、#26 或父规格 #14。基于 `54ac570`，交付前合并最新集成 `4a73365`；共享依赖由 #24 提供，本检查点不修改 package／lock／SDK 版本。

## 宿主装配接口

`src/adapters/mcp/boundary.ts` 导出 `McpBoundary`。一个应用在最终 clock／retention／sanitization 控制端口装配完成后创建**一个实例**，由所有实际日志与代码 Adapter 显式共用，安装它提供的 sanitization 包装。真实来源工厂必须要求该实例；既有 `mcpEvidencePorts` 仅为旧调用兼容保留可省略的第三参数。

- `run(context, leaseKey, endpoint, authorize, work)` 为一次逻辑调用拥有独立 SDK Client／stdio 连接；回调收到宿主绑定的不可变 context、`connect`／`listTools`／`callTool`、当前性检查及结果净化。没有暴露 Client、通用 request、资源读取、动态工具或 SDK 私有字段。
- `chargeEvidence(operation.context, sanitizedValue)` 必须使用本操作绑定的 context，在校验当前轮次、宿主清理信号与安全片段后同步累计完整安全正文，跨 Adapter／页／phase 共用同案 256 KiB；未结束或被拒绝的工作不释放已记额度。全部字符串继续受 16 KiB 限制，标签／观察／元数据／警告由来源转换器一并计入完整安全正文。
- `onClear(handler)` 登记同步宿主清理，清理每个来源自己的原值映射／计数；`clear` 尝试全部 handler 与原 sanitizer，失败者保留可重试的所有权及关闭状态，不因一个抛错跳过其他来源或误报删除成功。失败清理、尚未结束的操作及待清理的输入映射均占有有界案件位置。
- `OwnedMcpEndpoint.close` 是可选的宿主函数，单独捕获，不能放入 JSON／工具参数／审计或由模型提供。它须拥有原始未完成创建过程，等待其确定后停止并核实整个资源；不能把“当前尚不存在”当成稍后不会创建。stdio 子进程关闭、外部资源 close 与原始工作结束全部确认后才释放跟踪；close 的 pending／rejected 不会变成保留删除完成。此接口不增加新计时器，使用现有应用／C 的五秒清理窗口。

具体来源继续拥有固定 manifest、server／协议／能力／schema 比对、受限参数编译、授权资源／快照验证、结果解析、可靠意图／结果审计及原值映射。边界没有自动信任任意 manifest，也不选择原生工具。它在各物理动作和最终释放前调用来源提供的当前授权检查；证据发布与映射提交仍须在最终 fence 后同步完成。

## 保留的拒绝与生命周期行为

复用独立 MCP SDK 1.32.1 Client 与既有 `BoundedStdio`：实际累计原始 UTF-8 字节在转换／解析前限 1 MiB，初始化、工具清单、分页、progress 和错误使用同一计数；严格 UTF-8、framing、ProgressNotificationSchema／token／字段及回调异常均维持 fatal close。SDK 的 `jsonSchemaValidator` 仍在 listTools 缓存前拒绝未审核 outputSchema，不能提前编译源 schema。合成 profile 的固定 manifest／能力检查没有泛化。

每案最多两个连接，全局数量由 `MAX_ACTIVE_CASES` 推导，无无界排队；注册宿主生命周期发生在首个 await 前。后续 clear 的信号覆盖初始化前等待，旧 phase／clear 后的原始工作不能重建案件额度或提交映射。结果审计等待、最终重验及异步回收期间的迟到 fatal／取消仍拒绝结果。各案件独立，原始挂起工作与实际 close 的确认持续对 C 可见。

原合成 Adapter 的日志行数／覆盖范围、查询、日期、manifest、审计与别名规则保留在 `evidence.ts`；完整安全结果页改由共享实例收费。现有 CodeEvidence 额外受限方法通过保留注入的 `ports.code` 实现保持兼容，不新增合成原生工具或声称其协议覆盖。

## 实际验证

固定 Node 24.22.0、TypeScript 7.0.2、@types/node 24.10.0：离线 ignore-scripts 安装、严格项目类型检查、构建通过。沿用 #23 的 `skipLibCheck:true`，已知 42 个 Pi 上游声明问题仍为明确限制；本检查点没有把完整第三方声明检查记为通过，也未增加 any shim。

首次公开 B 混合工厂测试因共享边界与参数尚未实现而 RED；提取后，两个独立 Adapter 实例共用一个案件正文额度，日志十四次跨 phase 后代码结果被拒绝。原 50 项 MCP 协议回归继续通过。另有公开 B／C 验证：取消时原始外部资源尚在创建、创建后 close 仍挂起，删除始终 partial；资源真正结束后才 deleted；stdio 已结束但外部 close 拒绝仍 partial；一个来源及原 sanitizer 的清理抛错不跳过其他来源，失败所有权可由 C 重试确认。

全部 **266 项** macOS arm64 行为测试通过；同一编译产物在固定 Linux arm64 Node 镜像、无网络、只读根目录／代码、64 MiB 临时目录、512 MiB／pids=64、测试文件并行度 2 下全部 **266 项** 通过。保留全部既有 262 项测试，新增四项公开行为测试；用例内并发继续执行。`git diff --check` 与本地文档引用检查通过。

Linux 命令沿用 [#20 的受限验证方式](issue-20.md)，仅将 bind mount 换为 `/tmp/bau-spec14-worktrees/issue-25`；固定镜像 digest 为 `sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`。本检查点仅运行公开合成 MCP 服务和宿主可控资源替身，未启动私有参考制品、读取现有服务配置、访问真实资源或添加 HTTP／OAuth transport。实际来源的许可证／公告／制品、固定闭合契约和完整本地协议报告仍由后续 #25／#26 交付验证。
