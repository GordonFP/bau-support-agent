# 27502b1 结构维护性修复

基线为 `codex/poc-integration@27502b1a0808dc05595b00cd1b86493cd7e433d6`，用户 CQ01–CQ05 报告 SHA256 为 `c2ea5b6540f351c4051fe183d8945da78ca3c35c2d1146bd936b36bdb056c664`。本轮沿用 #14 的 A–D 公开测试接口；用户“继续”确认了 C 交付账本与 D 宿主票据的具体扩展。只使用 Mock、合成样本和 loopback 协议服务，未新增依赖、框架、限界上下文或业务操作。

## 结构与所有权

| 项目 | 原结构 | 当前所有者与不变量 |
| --- | --- | --- |
| CQ05 就绪依赖 | 主类长期持有 Partial Ports、可选 scope，多处断言重建依赖完整性。 | 构造入口一次返回完整依赖与验证 scope，或不可用原因；不可用 A façade 保留 service_unavailable／denied 及超限输入优先级。业务实现只持有完整 Ports，queryWindow／资源／模型能力归自身所有。模型能力 enabled／disabled 单独表达，缺模型政策仍只在模型发送准备时拒绝，不提前拒绝可检索案件。 |
| CQ01 轮次资源 | work、aborts、closures、closedPhases、stopping 五组集合对账，并另存 admissionCloseFailed。 | PhaseExecution 独占 immutable context／controller、原始 producer／children、一次 abort、唯一 close promise 与关闭结果；RunningCase 只按 phaseId 索引 owner。HostExecutions 持有受理前原操作、恢复读取／披露原操作以及关闭失败的 owner；CaseControls 持有轮次封口后仍合法的案件终止写入、释放、审计及安全通知。工厂在开工前检查 sealed 状态；close 动态等待所有原工作与最终 abort 后封口。调查 raw producer 与关闭 finalizer 分开，避免自等；业务终态、本地等候结束和真正 settled 保持独立。 |
| CQ03 模型执行 | 通用 guarded 用 action 字符串解释模型元数据、记录、费用；重试依赖异常对象身份。 | ModelExecution.generate 独占准备、准入、输入记录、预留、实际发送、最终／未知结算与一次网络重试，复用 PhaseExecution 原工作跟踪。每次尝试独立计数及 callId，共用原 60 秒期限和案件／POC 账本。guarded 无模型分支、费用结算或 networkFailure 身份协议。 |
| CQ02 场景目标 | 两组候选、PSP customer／boundAt／日期及多组 selected raw/ref 平行字段。 | SimulatorTarget、PspTarget 各持 locating／choosing／fixed 判别状态；候选和固定目标将 raw 标识与同案安全引用配对保存。自动唯一选择和补问提交共用 selectCandidate。补问先取得纯选择值，预算与审计成功后才 commit，暂时失败不会消耗选择。直接 PSP observation 也固定完整客户／申请／店铺／绑定／boundAt。领域仍维护 Simulator 完整提交店铺／业务日期及 PSP 绑定不漂移。 |
| CQ04 交付账本 | D 读取完整案件并扫描 audits；通用 auditInsert 根据 action/details 隐式写 deliveries；通信自建完成回调。 | C deliveryLedger 显式 begin／complete／read，统一 legacy binding 编码、票据、pending／complete 判定与原子审计。D 只消费类型化收据、opaque binding 和 C 确认位，不读完整记录或扫描审计。单次 dispatch claim 与完成确认都只持独立布尔位，不持案件、context 或 ALS Promise。固定审计故障提示仍独立限容 32，不伪造 durable completion。 |

首个复审生产检查点为 `1e03afd183939939e3a4c2d978825f668cd477b8`；独立复审后的最新代码为 `666135b5700b78379954f28d5d6a1ae7462c6e5a`。最新主编排文件由 1051 行降至 910 行；dependencies 44、PhaseExecution／HostExecutions／CaseControls 105、ModelExecution 105、SimulatorTarget 67、PspTarget 87、交付账本 126 行。行数是定位材料，结构验收依据是上表被删除的并行状态和隐含协议，不以搬文件或行数评分替代。

## C／D 契约

`deliveryLedger.begin(context, {kind, deliveryKey, segment, binding})` 产生 new ticket，或 existing receipt；同 key 不同绑定为 binding_mismatch，不发新票据。每个新票据的 dispatch.claim 仅一次成功；完成 bit 只在 C 完成事务提交后为 true。complete 只接受 status／receiptRef，拒绝额外字段、非字符串或非 64 位十六进制收据；相同完成幂等，矛盾完成拒绝；同 kind 的 callId 不得绑定另一个 deliveryKey／segment，该不变量由共用 C 实现检查，两 adapter 拒绝语义一致。

D 尝试通过 state 判别 new(ticket)／existing(bindingRef, receipt)／fault，删除三个平行可选字段及 ticketless 恢复分支；所有支持的历史结果均走同一个最终资源／身份 fence，固定故障提示另限容。

read 按 actor、caseRef、deliveryKey、segment、bindingRef 返回 absent／pending／complete／binding_mismatch 或拒绝的 null。查询先快照，沿用 records.read 的 requester／technical 完整读取授权，业务复核角色无此权限；保留资源、当前授权与 retention 披露检查。拒绝／故障不当作 absent。C 只读取案件 authority 和对应交付行；历史 stage 只在 C 内用对应 callId 的审计元数据判定，D 不承担格式兼容。begin 也独立校验当前动作授权，不能靠调用顺序获得结果恢复权限。

Mock 和 SQLite 以相同显式协议写入交付行与意图／完成审计；SQLite 保持同一事务和原 audit fault checkpoint。普通 audit 不再识别 delivery action 维护交付行。AuditBoundary 装饰 typed begin／complete，只在原子审计故障时锁定审计不可用，普通授权／绑定拒绝不冒充审计丢失。所有 SQLite controlPorts／bootstrap 注入点将 records、audit、budget、deliveryLedger 配套注入。

## 已执行验证

普通证据目录：`/tmp/bau-structural-275-evidence/`。所有命令使用 Node24.22.0／TypeScript7.0.2；重型检查串行。

| 检查 | 实际结果 |
| --- | --- |
| CQ05 基线与重构 | 原 A Simulator／bootstrap／PSP 72/72 → 72/72；`cq05-baseline.log`、`cq05-green.log`；项目 type／build 通过。 |
| Phase 所有权与封口 | concurrency／information／bootstrap／retention 99/99；`cq01-green.log`、`phase-seal-green.log`。包含迟到受理、原工作未 settled、未知关闭、终态单航班读取、Mock／实际 Teams GC。 |
| 模型执行 | budget／model-control／model-protocol／pi-runtime 74/74，0 fail/skip；`cq03-final-green.log`。 |
| 场景目标 | information／PSP／Simulator／PSP native／PSP Kibana 111/111；`cq02-green.log`。 |
| 组合回归 | 场景、C/D、phase、bootstrap／retention 273/273，0 fail/skip；`cq04-green.log`。 |
| 最终 C／D 组合 | communication／records／teams-ledger／teams-ack／teams 88/88，0 fail/skip；`cq04-final-green.log`。含新增 C 两 adapter 查询快照、类型化收据、结果白名单、撤权、无需完整记录披露、SQLite 原子回滚，以及 D 原票据淘汰后不可重放。 |
| 项目类型／构建、repair diff | 通过；`cq04-typecheck.log`、`cq04-build.log`，`git diff --check`。 |

真实缺口的红绿来自公开 A／C／D，而非私有 owner／map 测试：

- `target-retry-red.log`：一次预算状态读取故障后，第二次有效补问得到 needs_information；`target-retry-green.log` 改为 resumed。选择现在延迟到预算／审计提交后才固定。
- `cq04-query-red.log`：暂去掉 query 快照，在授权等待中改查询对象，两 adapter 均错误得到 absent；恢复快照后组合通过。这是明确的反事实 RED 对照，不冒称未经适配运行旧版 ledger。
- `cq04-result-red.log`：额外 caseRef 与 BigInt receipt 不能得到安全的 invalid_request；严格白名单修正后两 adapter 保留 pending、completion=false，组合通过。
- `cq04-claim-red.log`：原票据经 4096 缓存淘汰后，pending 恢复路径再次物理写入；C 单次 claim 后返回 unknown，物理次数不增加。原未知结果和固定故障缓存不重放。

中间失败未记通过：50k 输入小于原 65536 字节上限，首个新增 fixture 的 invalid_request 期望错误，改为 70k；首次 C/D fixture 沿用通用 audit hook／缺新 ticket，两个 final-write gate 等不到并触发 20 秒测试宿主 timeout，该次自有测试进程被停止，随后等价迁移到确认的 C/D 接口。另一次 SQLite 矛盾完成校验在通用事务安全错误转换后成为 audit_unavailable，现将同步检查与写入事务保持相邻且不跨 await，保留 invalid_request；原子审计失败仍为 audit_unavailable。首次单次 claim 检查错误用于独立 fault 路径，原固定提示回归拒绝该变化，已限定为常规交付票据后复验 88/88。未降低业务 deadline、容量、费用、权限、GC 或未知结果断言。

## 独立复审与增量修正

三份固定 `1e03afd` 报告分别为 `review-spec-1e03afd.md`、`review-standards-1e03afd.md`、`review-depth-1e03afd.md`。结构轴认可 CQ02–CQ05 的职责转移，但确认 CQ01 的封口轮次仍被用于后续案件终结；Spec 另指出 D 两条持久恢复返回缺最终 fence，以及两 C adapter 同 callId 换 key 的失败语义不一致；Standards 建议把新的平行可选 D 字段收为判别状态。上述四项均在 `666135b` 修正，没有重开已 closed phase。

- `paused-terminal-red.log`：原 phase 真正关闭后，cancel 返回 denied，补问预算耗尽也返回 denied。CaseControls 改为宿主跟踪的案件控制 owner 后两条 GREEN；`case-controls-expanded-green.log` **146/146**，包括 PSP 同路径、持有终态 append 时 host.close 仍 pending／释放后 closed、Agent.close 不增加，以及 Mock／实际 Teams 各 40 个等待补问后取消案件 GC retained=0、close=40，实际 Teams 仅 120 条预期通知。
- `delivery-operation-red.log`：同 callId 改 deliveryKey，Mock 错误发第二张新票，SQLite 返回 audit_unavailable；统一 C 操作绑定检查后 `delivery-operation-green.log` 两 adapter 均为 invalid_request，第二交付行／意图不存在。既有“同 key 改绑定”仍返回显式 binding_mismatch；最初过宽的校验使原两项收据合同失败（`delivery-state-green.log`，90/92），已收窄并重验。
- `delivery-recovery-red.log`：4096 项缓存后挂起 C 收据读取，撤回 identity／resource，再返回 delivered 收据，两条原分支仍披露 delivered。统一 recover 后两条均 failed，额外物理 POST 为 0；new／existing／fault 判别状态同时删除了无票据的模糊恢复路径，缺 state 的 JS 输入在共同入口安全拒绝。
- `review-fixes-final-green.log`：最新源码的相关 A／C／D、场景、phase、retention／bootstrap **238/238，0 fail/skip**；`review-fixes-typecheck.log`／`review-fixes-build.log` 通过，repair `git diff --check` 通过。

根代理的 `root-checks-1e03afd.md` 另保留中间源码 macOS／受限 Linux 各 **515/515**、自有完整严格闭包、Pi／Teams 正负 consumer、Teams 本地互操作、原 F01／F02／F03 与迟到关闭失败探针结果。R01 探针明确把最终查权触发从第 3 次适配到第 4 次，因为 C ledger 新增一次查权；拒绝时只有 status，允许时 status+Simulator。这些是中间证据，不作为 `666135b` 的最终源证明，也没有用全套通过覆盖后来发现的 paused-cancel 缺口。

## 最终源码验证

`666135b` 的增量 Spec／Standards／结构复核均完成，原 findings 闭合，无新增确认 finding／硬违约／有意义 smell；三份 `review-{spec,standards,depth}-666135b.md` 与原 `1e03afd` 报告累计覆盖基线至最终生产代码。结构轴确认 CQ01–CQ05 均成立。

根代理执行收据 `root-checks-666135b.md` 和本轮最终日志记录如下；没有把先前检查点或仅类型／静态复核替代行为执行。

| 最终检查 | 实际结果与日志 |
| --- | --- |
| 项目类型／构建 | exit 0；`root-typecheck-666135b.log`、`root-build-666135b.log`。 |
| macOS 全行为 | **525/525，0 fail/skip**；`root-macos-666135b.log`。 |
| 受限 Linux 全行为 | **525/525，0 fail/skip**；`root-linux-666135b.log`；固定缓存 Node、pull=never、无网、root／checkout 只读、512MiB、pids64、64MiB tmpfs、concurrency2。 |
| 自有完整严格声明闭包 | exit 0；bootstrap／MCP／Kibana／CBM／管理入口的 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes、skipLibCheck:false；`root-own-strict-666135b.log`。 |
| Pi／Teams 严格 consumer | 均 exit 0；Pi 正例接受／负例 TS2322（原窄 vendor 例外保留），Teams 完整声明正例接受／负例 TS2769；`root-pi-consumer-666135b.log`、`root-teams-consumer-666135b.log`。 |
| Teams 本地互操作 | exit 0；实际签名 route、OAuth404、success／429／reset 每次仅一个物理 POST；`root-teams-interop-666135b.log`。 |
| 局部协议 | **9/9，0 fail/skip**；`final-local-protocols-666135b.log`，实际 `/Users/gordon/.local/bin/postman`、本地 Responses／Kibana／Connector 与独立 HTTP 合同，含 PSP Pi/MCP。 |
| joined native | **3/3，0 fail/skip**；`final-joined-native-666135b.log`，实际固定 Pi、Kibana、CBM 与签名 Teams，显式 `/tmp/bau-spec14-context/kibana-test-artifact.json`，fixture 只覆写 loopback 和合成 key。 |

根独立公开探针全部 exit 0，逐项观察：构建完成后的 paused cancel 为 stopped/cancelled 且 C 相同（`root-paused-terminal-666135b-after-build.log`）；原 F02/F03 为 `.500Z`、40 迟到受理 GC 前后 retained=0、调查0／close40；迟到 close 失败仍 unknown；F01 为32断开请求／1挂起原读且独立终态 HTTP200／Postman exit0；R01 拒绝仅 status，允许 status+Simulator，两次 Postman exit0。对应 `root-original-f02-f03-666135b.log`、`root-late-close-666135b.log`、`root-terminal-http-666135b.log`、`root-identity-{denied,allowed}-666135b.log`。R01 的第4次查权适配理由与上节一致；较早在构建命令仍运行时启动的同 SHA paused probe 不作为最终证据。

原 native snapshot 14 项、镜像构建交错 1 项的源代码／管理器／构建脚本未变，本轮没有重复执行，不冒称本轮通过。受影响的应用／C／D／模型、PSP、共享 native 组合已按上表实际执行。新固定 archive 的真实镜像及合同见下节；旧 77b36f7／99f75db／300c163 制品仅作历史证据，未覆盖或冒作本轮镜像。

## 最终实际镜像

使用默认真实 `/usr/local/bin/docker`，显式取消 BAU_IMAGE_DOCKER override，从 clean Git archive 实际重建；fresh 目录 `/tmp/bau-image-structural-275-69ff778dc9bc09fcaf6c4370f488ac6f5740cbab/` 保存 source archive／编译清单、Docker build log／iidfile／inspect／save archive、inventory、OCI layout 与 receipt。此来源相对生产检查点 `666135b` 只增加交付文档；src、management、runtime Skill、Postman、构建脚本和运行配置字节不变。

| 身份 | 实际值 |
| --- | --- |
| Source commit / inspect revision | `69ff778dc9bc09fcaf6c4370f488ac6f5740cbab` |
| Source archive SHA256 | `f5edb573fc2102d237ac25e5e71d07f5509ec9cc24835523e065383df6b544dd` |
| Docker config / iidfile | `sha256:2107c36209de3b0cfd4ed5cf1bde61661798a3afb0a91ca01492263f3185bb0f` |
| OCI manifest | `sha256:e2f439afcddca00e3e700e68fbb7f5994b40f966a3054c55f6bf620f73865faf` |
| OCI index | `sha256:f7638e0444495a9efea9c6d96447baa7c5fb79bbcbd11767bc99f21be634ffae` |
| Docker save archive | `sha256:da441c05d0d3e06e7861f4bac5b99cbeb20cff6e287d51006131ee4f5e8281cd` |
| Inventory SHA256 | `228a255577c0df5d0ed9397d2e2e1533f42a9746a1bea2c63febe554eea146b0` |
| Lock SHA256 | `e77e5783fa35a84b5d110111d337e13198bdde93b3db67453ec2ecf32db42ecc` |
| Runtime Skill SHA256 | `e204643dabd38e47d884b5aee74846b060e18fee46a50b3a6ddfd336f3d16a69` |
| 平台／工具链／应用清单 | `linux/arm64`、Node24.22.0、TypeScript7.0.2，71 个实际 JS 的路径／字节数／SHA256 与固定来源逐项一致。 |

`final-image-build-69ff778.log` 构建 exit0；`final-image-contracts-69ff778.log` 原容器／OCI合同 **6/6，0 fail/skip**；`final-image-source-69ff778.log` source canary **1/1**。保留原非 root、无网、只读、权限／资源／存储拒绝、两场景、重复键／费用、取消／超时／未知关闭、审计故障、OCI 内容链／篡改拒绝及忽略额外 TS／陈旧 JS 的全部断言。没有使用可变 tag 作为验证身份。

`final-image-verification-69ff778.json` 另记录实际 source.tar 与 Docker-save 文件流式散列复核、iidfile／inspect／receipt 同 ID、revision、source 清单／inventory 逐项相等。`final-owned-containers-69ff778.log` 与 `final-owned-volumes-69ff778.log` 均为空；仅清理合同自有资源，既有其他数据库容器／卷未动，canary 文件也已删除。没有 registry 上传、远程 pull 验证或部署。镜像来源 pin 之后只有文档收据提交，未更改生产字节。

```sh
env -u BAU_IMAGE_DOCKER node scripts/build-image.mjs /tmp/bau-image-structural-275-69ff778dc9bc09fcaf6c4370f488ac6f5740cbab
BAU_CONTAINER_IMAGE=sha256:2107c36209de3b0cfd4ed5cf1bde61661798a3afb0a91ca01492263f3185bb0f BAU_OCI_LAYOUT=/tmp/bau-image-structural-275-69ff778dc9bc09fcaf6c4370f488ac6f5740cbab/oci node --test --test-concurrency=1 dist/tests/contracts/container-runtime.test.js dist/tests/contracts/image-oci.test.js
BAU_IMAGE_INVENTORY=/tmp/bau-image-structural-275-69ff778dc9bc09fcaf6c4370f488ac6f5740cbab/inventory.json node --test dist/tests/contracts/image-source.test.js
```

## 范围与限制

保留原 42 项 Pi 上游 TS1543 声明限制和窄 skipLibCheck 例外；自有严格声明闭包与 consumer 分别核验，不能把上游全部声明记为通过。历史完整分支 diff 的第三方许可证 CRLF／末尾空行限制不改，本轮 repair diff 另查。

先前专门独立安全候选复核因工具内容审查中断，仍未完成；本轮普通功能／结构复核不替代它。未执行真实模型、公司网关、真实 Teams 租户、生产日志、内部 GitLab、G2–G4、registry 上传、Kubernetes apply 或部署。#14、#30–32 保持 OPEN，无 Go，Mock／本地协议／镜像通过不构成真实联调完成，也不据此关闭父规格。
