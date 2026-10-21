# a13f5c8 review 修复交付

用户提供 `/tmp/bau-poc-review-validated-a13f5c8.json`（21 项：1 high、20 medium）。基线为 `a13f5c863389cc7b1dc9e2c403ae314a808b2cc2`，集成目标仍为 `codex/poc-integration`。本轮修复由一个实现者在独立分支完成，沿用已确认 A–D、独立索引管理和容器/本地协议合同；没有新增业务操作、真实接入或访问批准。

全部运行只使用 Mock、合成样本、临时受控 SQLite、本地签名 Teams/Responses/MCP/Kibana/GitLab 服务和已固定的本地 Docker/CBM 制品。#14、#30–#32 的真实前置条件仍未齐，本轮不关闭这些票、不宣布 Go，也不合并 main、发布 registry 或应用 Kubernetes 配置。旧 458 项检查、旧镜像及旧交付记录保留为历史，不改写其来源身份。

## 逐项处置

| 项 | 修复与公开边界回归 |
| --- | --- |
| R01 | 宿主授权新增可选同步 `current(action, context)`：它必须从与 `allows` 相同的权威策略/撤权状态直接判断，严格 `=== true`；不能返回 Promise、缓存旧允许结果或默认放行。只有 local Teams 强制要求此能力，缺失时启动拒绝。每段实际写入的末检同时验证当前身份、实际发送动作、JWT、原 deadline/取消；HTTP ACK/get 将身份与 A.get/C.read 的资源和生命周期 fence 组合。两方向暂停查权再撤权、查询/重启 SQLite 查询、无能力及非 boolean 均验证拒绝。 |
| R02 | 分别约束候选与完整实际 assistant content（文字、工具调用/ID/参数、序列化转义）加 reasoning，取较大上界，避免同一候选双计。超大 message 和工具调用不能留存或进入 transcript。本地 Responses 上游在生成 delta 前按同一定义执行 4k；精确上限/下一字节合同同步更新。 |
| R03 | 有效补问恢复先安装新轮绝对 timer；初始 view 写入仍属原工作，但本地等待受新轮 deadline/信号约束。持久化挂起超过 180 秒时停止并返回，不开启调查，不把原写入当已结束。 |
| R04 | 领域冻结首个实际观察的申请、业务提交日和提交店铺集合；重复读取冲突拒绝，店铺顺序不构成集合改变。最新计算等事实只引用实际供应该观察的本次读取证据，保留其观察时间，不能借第一条旧日志回溯新事实。 |
| R05 | 唯一客户候选和补问候选均不再从 UTC 时间字符串推定业务日；由所选申请来源观察给出并冻结业务提交日。两种路径均覆盖 UTC 前一日、Asia/Singapore 业务次日。 |
| R06 | 已确认目标绑定排除同店其他旧绑定的历史通过；其他店存在多个绑定且当前绑定未确认时保持未知，不把它们分别算作可用通过。独立其他店合法较早通过不受目标店绑定时间全局淘汰。覆盖新绑定未控、无结果/未知，以及其他店绑定变化。 |
| R07 | 观察时间未知、无效或晚于报告形成时间的 Simulator 支持不能成为验证事实。一个结构观察混有时间无效的支持时整批结构结果保持未知，避免借同页较早日志支持未来计算；报告保留时间冲突说明和原证据元数据。 |
| R08 | 1 MiB 为单项写入限制，读取逐项复验已接纳记录/审计/交付安全，不对累计整案重复套用单次限制。两条各 600 KiB 的已接纳记录可读取/导出，业务复核仍只见报告/证据；单条超限仍拒绝。 |
| R09 | Mock 私聊入口接受既有 `scenario/shopId/bindingId` PSP 业务字段，继续拒绝主体、资源等控制字段。合法 PSP 实际到达 PSP 报告。 |
| R10 | 先返回已有交付键结果；有界发送缓存到容量后，只淘汰 C 中已有完整完成审计和绑定摘要的 settled 项，未知原工作继续持有。缓存未命中从当前获准 C 总账恢复原状态/收据，绑定不同拒绝、不物理重放。扫描可回收项，不让首个不可回收通知永久挡住其余项；4100 段、旧键、未知键重复和不可回收首项验证。 |
| R11 | 终态 view 可靠保存，全部原始工作、agent close、各轮关闭、入站和补问控制确认结束后才 forget 证据并移除执行上下文/受理 Promise。未知原工作或未保存终态仍保留所有权。历史 A.get/重复入站通过 C 当前授权恢复安全视图；terminal cancel/provideInformation 保持幂等、旧有效回复仍 duplicate，不恢复调查。案主/get/cancel/provideInformation/accept 权限与技术角色 C 访问分开校验。公开 Agent 边界的 AbortSignal WeakRef 经独立 `--expose-gc` 子进程验证 40 案由保留 40 个变为 0 个，C 记录仍可用。 |
| R12 | `deletionStatus()` 在返回前观察并持久锁定到期。Mock/SQLite 的仅轮询截止日→UTC 回退序列仍关闭记录和受理，不重新开放。 |
| R13 | reader 的网络传输异常与 UTF-8/字节/schema 错误分开分类，保留最初协议失败；已收到合法非成功 terminal 后 codec 的 reader abort 仍按已结束 schema 失败处理。真实本地 HTTP 200/response.created 后 socket reset 可作唯一受控网络重试，首次原执行/费用未知保留，断流不成为完整诊断。 |
| R14 | 每个新制品目录有独立 `--iidfile`，严格读取本次不可变 ID；inspect 的 ID、平台及 revision 必须匹配该 ID/固定 Git sourceCommit，save、OCI、inventory 全沿同一 ID。共享标签仅用于人工诊断。管理员构建 CLI 的可选绝对 `BAU_IMAGE_DOCKER` 是独立命令边界，默认仍 `/usr/local/bin/docker`，不进入运行镜像。交错构建替身把标签换成 JS 相同、其他镜像输入不同的制品，观察到 inspect/save 仍使用本次 ID；替身不能产生实际 OCI 收据，实际镜像另验。 |
| R15 | 索引 coverage 必须与请求文件路径精确一一对应：数量、去重、requested_path/path 和 freshness 全校验。实际固定 CBM 经独立协议故障代理覆盖空、重复和额外路径，均不能发布 complete 收据。 |
| R16 | 确认原管理容器停止后，先恢复自有 staging 目录写权限再递归清理；即使 staging/pending 文件清理失败，仍在 finally 释放已确认无写者的锁。容器停止未知则仍保留锁。当前 macOS uid501 非 root 实测冻结后 `current.json` 发布失败、旧快照保留、锁释放和下一次正常发布。 |
| R17 | 跨仓 trace 保留实际请求目标，不再仅保留 boolean。A→B 返回 A→C 时 C 不成为请求目标的证明，结果降为 unknown；无目的元数据的 route 行继续未知。实际三仓 CBM/独立协议故障代理验证。 |
| R18 | 同案合并 alias 数量、累计字节和碰撞检查移到 success 完成审计之前，复用原 boundary 的同案 logs 原工作串行约束；实际绑定提交仍在最终 currentness fence 后。34 PSP 候选引入超过 100 alias 及碰撞均无 `ok` 完成审计。 |
| R19 | 意图之后的查权、Adapter 调用及确认解析统一覆盖完成处理。调用前失败记 failed，可能已写入或非法确认记 unknown；非法/null/status、非字符串或非法 receipt 均不通过，不重放。Mock/SQLite 交付总账同步保存安全完成状态。 |
| R20 | Kibana 替身先以 `gte <= event_time < lt` 过滤，再计算 total/分页。非重叠窗口为空，Simulator/PSP 两端边界正确；实际 Adapter 和既有 Postman simulation 另回归。 |
| R21 | Responses 替身按 48,000 字节限量累计 Buffer，结束后一次 fatal UTF-8 解码；跨 HTTP write 分开的中文字节仍原样返回，不出现替换字符，非法 UTF-8 拒绝。 |

## 红绿证据与当前检查状态

独立本轮日志保留于 `/tmp/bau-review-a13-evidence/`；R01 专用日志由根代理提供的 Codex Security 临时制品目录管理。每项有 `rNN-red*.log`、`rNN-build*.log`、`rNN-green*.log`；R02 另有 upstream 红绿，R10/R11/R13 的后续组合回归另行保留。有效红均来自回归行为失败，不把基础设施错误算作业务红。

- 已执行的聚焦检查包括：communication 8 项（后增非字符串 receipt）、model-control 12、information 25、Simulator 26、PSP 40、retention 截止锁定 2、累计记录 1、Mock PSP 入口 1、alias 负例 2、独立 HTTP mock 3、R15 native 3、R16 非 root native 1、R17 三仓 native 1、R14 交错构建 1。后续组合生命周期 120 项通过记录保留。
- 代码检查点 `6158ff4d96220ff904b2e5e6ddd28caa6237326e` 的 Node24.22.0 / TypeScript7.0.2 项目类型检查和构建通过；ACK/currentness 10 项通过。完整 macOS/Linux、strict consumer、实际 Postman/native 全合同、新固定 Git archive 镜像及 source/OCI 合同在最终固定代码后串行执行，结果另附本文件，不把待执行项记通过。
- R04 最初绿色构建发现 acceptResult 回调返回类型错误（TS2345）；同次旧 dist 测试不算绿色，修正 void 回调后重新构建，`r04-green-corrected.log` 24 项通过。R05 相同旧构建影响已排除，恢复旧 UTC 推断取得有效 red，再去掉推断取得 `r05-green-corrected.log` 25 项通过。
- R13 最初组合检查暴露保留费率期望错误，以及 codec reader abort 覆盖 terminal 分类；修正为两个未知费用预留和保留最初失败后，最终组合记录保留。没有改成免费或提前释放未知原执行。
- R15 最初故障代理未正确关闭 stdin，三项各约 45 秒超时并留下 unknown-writer 锁，不算覆盖规则的有效红；修正代理退出、清理本轮准确命名的三个自有容器后，重新运行获得三项有效行为 red，再取得三项 green。没有操作已有数据库容器。
- R11 的第一次组合检查发现新增 Mock lookup 的异步顺序、终态 view 持久化失败时过早移除、旧 A.get 审计暂停 fixture 失去触发点；分别保留控制开始后才推进 fake clock、终态可靠保存后才释放，以及原 A.get 审计契约。一个旧 fixture 的挂起 run 已主动终止并保留日志；后续每测试有有限宿主超时，未减弱撤权断言。R01 两方向回归最终通过公开 D 单独隔离实际写入，防止暂停入站 ACK 的身份检查被误当成报告身份检查；根代理另保留原 A 业务输入/暂停次序的独立回放。
- R01 专门 fresh 独立安全候选审查在工具内容审查处中断，未形成可用结论；没有重试规避限制，不记为 0 finding 或通过。根代理的源码挑战、合成行为验证与后续普通双轴 code-review 分别记录，不能覆盖这次中断。

## 制品、外部条件与既有限制

新的应用字节必须用本轮修复后的构建器从固定 Git archive 重建实际镜像；旧 `/tmp/bau-image-final-review-8e68dd56af7553212a5b8f5c3b6d003105eb7294` 为历史镜像，不作为本轮 runtime 证明。新制品的 source SHA、Docker config、OCI manifest/index、inventory/lock/Skill digest 和实际检查结果在完成后追加。

Pi 上游 42 项声明 TS1543 与已批准的窄 `skipLibCheck:true` 限制继续保留；项目与自有完整声明闭包、正负 consumer 分别验证，不冒称 Pi 全部声明已通过。许可证原文 CRLF/末尾空行的整段原始 `git diff --check` 退出 2 也保留历史事实，不规范化原文或散列来伪造通过。本轮自身 diff 检查单独执行。原 Teams deadline 测试的历史间歇首败和根因未证实记录保持原样。

不添加/升级依赖，继续固定 Pi1.3.0、Teams2.1.1、MCP1.32.1、CBM0.12.1、Node24.22.0。Docker `--iidfile` 的语义核对官方 [build 参考](https://docs.docker.com/reference/cli/docker/image/build/)；CBM 的完整性解释仍以固定实际制品和本地协议结果为准，[官方仓库](https://github.com/DeusData/codebase-memory-mcp) 的 best-effort 描述不证明历史业务执行。既有第三方许可证适用性、发布来源关联及实际部署的安全/版本重核条件仍见历史交付，不由本轮 synthetic 检查解除。
