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
| R10 | 先返回已有交付键结果；有界发送缓存只淘汰已可靠完成审计的 settled 项。宿主仅在 C 完成审计成功后确认的小型 receipt，使淘汰不依赖旧案主后来的 C 权限；兼容既有直调用的项仍复核 C 完成状态与绑定摘要。未决原工作不遗忘。缓存未命中按该键自身当前 C 授权恢复原状态/收据，绑定不同或撤权拒绝、不物理重放。验证 4100 段、旧键、unknown 重复、不可回收首项、4096 个旧案全部撤销 C 后新案仍成功。未可靠审计的固定 fault 通知另有 32 项缓存：满后拒绝新 fault，保留旧 unknown 与跨入口同键去重，不能占普通发送容量或伪称持久成功。 |
| R11 | 终态 view 可靠保存，全部原始工作、agent close、各轮关闭、入站和补问控制确认结束后才 forget 证据并移除执行上下文/受理 Promise。未知原工作或未保存终态仍保留所有权。历史 A.get/重复入站通过 C 当前授权恢复安全视图；terminal cancel/provideInformation 保持幂等、旧有效回复仍 duplicate，不恢复调查。案主/get/cancel/provideInformation/accept 权限与技术角色 C 访问分开校验。Teams settled 缓存仅保留纯结果与只持确认位的 receipt，不保留原 ALS Promise；原 proof/write 真正结束后才去除传输 lease 的阶段引用，最终 proof fence 仍持原信号作末检。公开 Agent AbortSignal WeakRef 的 Mock 与实际 local Teams SDK 两种独立子进程均验证 40 案保留 0 个，实际发送仍为 80 条，C 记录和重复键可用。 |
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
- 普通双轴在 `6158ff4` 确认 R10 尚有中等问题：所有旧案 C 权限撤销会阻断新案。新增公开 D 回归取得 `r10-all-revoked-red.log`，宿主可靠完成 receipt 修复后 `r10-all-revoked-green.log` 通过；`03694c6` 的固定跟进审查关闭原 finding，没有确认新 finding。后续发现不能持久审计的 fault 应独立限容，`r10-fault-red.log` 证实 4096 次 fault 使普通发送失败，`r11-wire-green-final.log` 与最终 23 项聚焦检查验证隔离后正常发送、原 unknown 不重放。
- 根代理在 `03694c6` 使用 Node24.22.0、同一公开 A/实际 SDK/签名 loopback 的独立 WeakRef probe，观察 Mock 为 0、Teams 为 40 个阶段信号保留；Git 内公开回归 `r11-wire-red.log` 同样得到 40。仅换小型 receipt/纯结果后仍保留最后 1 个，`r10-r11-wire-green.log` 和 `r10-r11-wire-green-corrected.log` 保留这两次未通过；原 HTTP ALS lease 真正结束后去除阶段引用，`r11-wire-green-final.log` 才为 0。
- 根代理在 `7c03395` 重跑同一独立 GC probe，Mock/实际 local Teams 的 stop 前后均为 0；40 次调查与 80 次物理消息不变。同一原 A 输入、第三次交付查权暂停时撤销身份的 Postman probe 仍仅发 status、report failed；普通允许对照发 status 与 simulator、report delivered，2 项 HTTP 断言通过。新增 `current` 能力只把同一权威撤权状态接入 fixture，未称原先不符合新能力的 probe 原样通过。原始日志由根代理 managed artifacts 的 `r11-wire-gc-03694-node24.log`、`r11-wire-gc-7c03395-node24.log`、`r01-final-7c03395-postman.log` 保留。

## 固定代码检查点的实际结果

最终生产代码检查点为 `7c03395f6ba343a99fd13e0b241eeb322ddf48e9`。后续交付文档提交不改变生产字节；镜像的固定 archive 来源另列下方，不能把标签或旧镜像当作来源证明。

| 检查 | 实际结果与证据 |
| --- | --- |
| 最终项目类型检查/构建 | 通过；`r10-r11-final-typecheck.log`、`r10-r11-final-build.log`。 |
| 最终 macOS 全行为 | **496/496，0 fail/skip**；Node24.22.0，concurrency2，每测试 15s 宿主上限；`final-macos-7c03395.log`。 |
| 最终 Linux 全行为 | **496/496，0 fail/skip**；固定 Node config、无网、只读 checkout/root、512MiB、pids64、64MiB tmpfs、concurrency2，同一宿主上限；`final-linux-7c03395.log`。 |
| 最终自有完整闭包 strict | `skipLibCheck:false` 通过；`final-own-strict-7c03395.log`。Pi 全 vendor 声明限制不因此解除。 |
| 最终通信/Teams ACK/交付总账 | **23/23**；`r10-r11-final-focused.log`。完整行为另外覆盖 C/SQLite/保留期限/原工作生命周期。 |
| 最终 joined native | **3/3**；`final-joined-native-7c03395.log`。实际固定 Pi、Kibana/CBM、合成 GitLab/HTTP；先前 `final-native.log` 中 joined3 因未显式给受控配置而在 preflight 失败，保留该失败；配置补齐后只覆写 loopback/合成 key。fixture 的 async/current 查权明确共用同一策略，未放宽范围。 |
| Codebase native 检查点 | **14/14**；`5262a98` 的 `final-native.log` 前 14 项，包括 uid501 非 root 的发布失败清理。此后只改通信/wire，不把该结果冒称重跑。 |
| Postman 检查点 | **9/9**；`5262a98` 的 `final-postman.log`，Responses/Kibana/PSP/Teams 与独立 HTTP 替身合同；Postman1.74.0 本地未登录，不上传。此后协议源字节未变。 |
| 严格 consumer / Teams interop 检查点 | `final-pi-consumer.log` 正例通过、负例 TS2322；`final-teams-consumer.log` SDK 完整声明正例通过、负例 TS2769；`final-teams-interop.log` 实际签名 loopback 通过。后续无版本或这些 consumer 更改。 |
| 普通独立双轴 | `7c03395` 固定复核 Standards/Spec 均 **0 新 finding**，明确关闭 R10 fault 容量及 R11 wire 滞留；根代理保留原报告 `artifacts/review7c/two-axis.md`。这与中断的专门安全候选审查分别记录。 |

先前完整检查点 `6158ff4` 的 macOS/Linux 各 492/492，`03694c6` 各 494/494，同样保留；新增两个交叉边界回归后总数为 496。文件名含 `green` 的中间日志若显示失败，也仍是失败，不能据名称记通过：R04 的有效更正为 `r04-green-corrected.log`，R05 为 `r05-green-corrected.log`；R13 三次中间 run 的失败保留，最终 `r10-r11-r13-green.log` 120 项组合及最新两平台全套均通过。

这些命令从固定 checkout 构建后的 dist 执行，Node 固定为 `/tmp/node-v24.22.0-darwin-arm64/bin/node`：

```sh
npm run typecheck
npm run build
node --test --test-concurrency=2 --test-timeout=15000 dist/tests/behavior/*.test.js
node --test --test-concurrency=1 --test-timeout=15000 dist/tests/behavior/teams-ack.test.js dist/tests/behavior/teams-ledger.test.js dist/tests/behavior/communication.test.js
BAU_KIBANA_TEST_ARTIFACT_CONFIG=/tmp/bau-spec14-context/kibana-test-artifact.json node --test --test-concurrency=1 --test-timeout=65000 dist/tests/contracts/codebase-kibana-native.test.js
```

Linux 原命令保持所有限制（没有拉取、改变运行期 deadline 或放宽断言）：

```sh
/usr/local/bin/docker run --rm --pull=never --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m --memory=512m --pids-limit=64 --mount type=bind,source=/tmp/bau-review-a13-worktree,target=/app,readonly --workdir=/app node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 node --test --test-concurrency=2 --test-timeout=15000 dist/tests/behavior/*.test.js
```

## 制品、外部条件与既有限制

新制品已由本轮修复后的构建器从 clean 固定 Git archive 实际重建，目录为 `/tmp/bau-image-review-a13-77b36f729c04562cdf3f38cecbd8e3ec7ee9f8a3/`；其中 `receipt.json`、`image-id.txt`、`docker-inspect.json`、`docker-build.log`、`docker-save.tar`、`inventory.json`、`source/` 和 `oci/` 保存实际字节。旧 `/tmp/bau-image-final-review-8e68dd56af7553212a5b8f5c3b6d003105eb7294` 为历史镜像，不作为本轮 runtime 证明。

| 身份 | 实际值 |
| --- | --- |
| Git sourceCommit / revision | `77b36f729c04562cdf3f38cecbd8e3ec7ee9f8a3`，生产字节等于 `7c03395`，此后只追加交付收据文档。 |
| Source archive SHA256 | `10052594d1554bf734d3270665f5fedf242141fc981132ce4d289791612723c6` |
| Docker config / 本次 iidfile | `sha256:4078489be6288f745b6ac95931d8cdbe5ff8d7ad8dd29f32c1a1c583bfdb37c5` |
| OCI manifest | `sha256:ceb50629f48f43cd57753edead47b787024a623883f9479ec0ff846b82caea88` |
| OCI index | `sha256:bea0fc6ead849941bb2493fff917053cbef1ce0860d4fa0aaeb755ab005436a2` |
| Docker save archive | `sha256:33792074539e56690e59050c1563fa12c0d5f4ab6a6eb4c5a9ca215eedb1857a` |
| Inventory SHA256 | `f03c29064b44db32ae07a0582d39709f063b2f1f14752e010f40a69f81ec07e5` |
| Lock SHA256 | `e77e5783fa35a84b5d110111d337e13198bdde93b3db67453ec2ecf32db42ecc` |
| Runtime Skill SHA256 | `e204643dabd38e47d884b5aee74846b060e18fee46a50b3a6ddfd336f3d16a69` |
| 平台/编译 | `linux/arm64`、Node24.22.0、TypeScript7.0.2，65 个应用 JS 与实际 image inventory 逐字节一致。 |

实际执行 `node scripts/build-image.mjs /tmp/bau-image-review-a13-77b36f729c04562cdf3f38cecbd8e3ec7ee9f8a3`，`final-image-build-77b36f7.log` 成功；最新交错标签替换合同 **1/1**（`final-image-build-contract-77b36f7.log`）。以以上不可变 config 和实际 OCI layout 运行原容器/OCI 合同 **6/6**（`final-image-contracts-77b36f7.log`）：非 root/无网/只读/资源限制、存储拒绝、两种场景、重复键与费用、取消/未知关闭/超时、审计失败、OCI 内容链及篡改拒绝均通过。source canary 合同 **1/1**（`final-image-source-77b36f7.log`）验证忽略的额外 TS 和陈旧 dist JS 均不进入 archive 编译，并与镜像 65 个 JS 散列/字节逐一匹配。合同自有容器和 volume 已清理，其他已有容器未操作；实际制品保留供集成核对，没有推送 registry、远程拉取验证或部署。

```sh
BAU_CONTAINER_IMAGE=sha256:4078489be6288f745b6ac95931d8cdbe5ff8d7ad8dd29f32c1a1c583bfdb37c5 BAU_OCI_LAYOUT=/tmp/bau-image-review-a13-77b36f729c04562cdf3f38cecbd8e3ec7ee9f8a3/oci node --test --test-concurrency=1 dist/tests/contracts/container-runtime.test.js dist/tests/contracts/image-oci.test.js
BAU_IMAGE_INVENTORY=/tmp/bau-image-review-a13-77b36f729c04562cdf3f38cecbd8e3ec7ee9f8a3/inventory.json node --test dist/tests/contracts/image-source.test.js
```

Pi 上游 42 项声明 TS1543 与已批准的窄 `skipLibCheck:true` 限制继续保留；项目与自有完整声明闭包、正负 consumer 分别验证，不冒称 Pi 全部声明已通过。许可证原文 CRLF/末尾空行的整段原始 `git diff --check` 退出 2 也保留历史事实，不规范化原文或散列来伪造通过。本轮自身 diff 检查单独执行。原 Teams deadline 测试的历史间歇首败和根因未证实记录保持原样。

不添加/升级依赖，继续固定 Pi1.3.0、Teams2.1.1、MCP1.32.1、CBM0.12.1、Node24.22.0。Docker `--iidfile` 的语义核对官方 [build 参考](https://docs.docker.com/reference/cli/docker/image/build/)；CBM 的完整性解释仍以固定实际制品和本地协议结果为准，[官方仓库](https://github.com/DeusData/codebase-memory-mcp) 的 best-effort 描述不证明历史业务执行。既有第三方许可证适用性、发布来源关联及实际部署的安全/版本重核条件仍见历史交付，不由本轮 synthetic 检查解除。

后继复审 F01–F03 的修复与新制品证据见 [71050d2 复审修复](rereview-71050d2.md)；本文件的检查点和收据保留为历史记录。
