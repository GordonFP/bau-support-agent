# 71050d2 复审修复

后续 CQ01–CQ05 结构改造及对应重新验证见 [27502b1 结构维护性修复](structural-27502b1.md)；本页保留原修复与历史制品事实。

本轮以 `codex/poc-integration@71050d2e54857ada36def1d069814e38d82ce2ff` 为基线，处理用户提供的 F01–F03；原复审报告 SHA256 为 `4b2df7cb669b44b6fd72816f888548fb7ba2ec77b9dcf76e62887ebe038a5515`。沿用 #14 与决议 #10 的 A–D 公开边界，只使用 Mock、合成样本及 loopback 协议服务。未修改原报告、历史镜像收据或既有规格。

## 处置与有效红绿

| 项目 | 修复与验证 |
| --- | --- |
| F01 终态控制读取无本地期限 | 已回收案件的 cancel、provideInformation 和共用 get 恢复读取，按主体／租户／目的会话／案件／动作合并同一原始 C 读取；不同 reply event 的幂等判断仍逐个计算。caller 最多等 5 秒，可信宿主可用可选 AbortSignal 尾参提前结束自己的等待。一个 caller 的取消不终止共享原读，不影响另一个 caller。最多保留 32 个不同原读，只有原授权／审计／read 真正 settled 才释放容量；过期原读的迟到结果不再披露。get 的每 caller 宿主披露回调独立限制 32 项、跟踪至 settled，并保留 C resourceCurrent、实际 owner、动作 current 与拒绝审计。原工作未结束时关闭保持 unknown。 |
| F02 调查前终态遗漏 close | confirmed admission 后的所有终态返回统一进入 closePhase，并作为宿主 controlWork 跟踪；终态 admission.release 也跟踪至原 Promise settled。受理确认或 accepted 审计超时后，即使尚未开始 Agent 调查，也要完成原工作、持久终态和 Agent.close 后才释放上下文，不恢复调查。 |
| F03 混合 UTC 精度选错时间 | 只将 Simulator 最新观察时间的比较改为 Date.parse 数值比较，保留实际支持该观察的证据引用；没有改其他日期处理。 |

普通证据目录为 `/tmp/bau-rereview-710-evidence/`，以下日志均保留实际结果，包括失败尝试。

- F03：`f03-red.log` 在公开 A/B 报告中实际得到 `2026-10-18T23:00:00Z`，期望独立字面量 `.500Z`；`f03-green.log` 通过，报告事实引用包含真正较晚的日志，所有引用有效。
- F02：`f02-red.log` 的 40 宗迟到 confirmation 在原工作结束后仍保留 40 个阶段 signal；`f02-green.log` 修复后为 0。`f02-additional.log` 另覆盖迟到成功 accepted 审计，两种各 40 宗，持久状态 stopped/timeout、重复键可用、调查未开始、Agent.close 完成。GC child 使用取消／触发后删除 timer 的 Set 时钟、公开授权及 Agent 边界和 C/A 读取，不读取私有 map。首个 `f02-red-build.log` 因 SavedContext 不声明 signal 而编译失败，不作为有效 RED；改从公开授权 context 观察 signal 后重新编译并取得有效行为 RED。
- F01：`f01-red.log` 中 cancel／provideInformation／get 各 32 个 caller 在 5 秒仍无答复；`f01-green.log` 三条路径均在本地返回 denied，挂起的原 read 仅 1 个。`f01-additional.log` 7 项通过，覆盖一个 caller 取消不毒化另一个、32 distinct 原读超时后仍占有限容量、宿主回调容量／关闭所有权、以及实际签名 Teams 32 客户端断开后独立案件 HTTP 200，原 read 仍仅 1 项且 stop 为 unknown，原操作释放后 closed。原读真正结束后可重新授权读取，不把迟到结果当作已披露。第一次 additional build 因授权 Port 只声明资源范围而不声明 caseRef 报错；使用公开对象属性收窄后 `f01-additional-build-corrected.log` 通过，不将编译错误记通过。
- 合并查询自查：`f01-view-isolation-red.log` 发现共享 raw 读的两个 caller 得到同一个可变 view；第一个改 phaseId 会污染第二个返回值。`f01-view-isolation-green.log` 通过；仅复制每个 caller 的 view 快照，C 记录仍独立，未增加持久缓存。

根代理独立回放保留在同目录：原 F02/F03 脚本只替换 import 路径，baseline 为 40 retained / 0 Agent.close、较早时间；候选为 0 retained / 40 Agent.close、`.500Z`（`root-original-f02-f03-{baseline,candidate}.log`）。F01 原 32 请求脚本的复现保持原样保留，另一个独立适配 probe 先准备两个已完成案件，只挂起 case-1 的 C read，等待 32 个已认证 cancel 后断开全部客户端，原读仍挂起时用实际 Postman 查询 case-2；同一脚本 baseline HTTP 503／32 原读，候选 HTTP 200／1 原读（`root-f01-independent-{baseline,candidate}.log`）。它将门闩从“32 个原读”改为“32 个入站身份通过”，以兼容正确合并；没有声称原门闩脚本不改即可作为 GREEN。两次状态断言均通过，baseline 非 2xx 的 Postman CLI exit 1、候选 exit 0，脚本均 exit 0。

## 270083b／b5c7efc 中间验证

生产检查点为 `270083bbcc00327a2d359978a177fb15262a74ac`；其前一检查点 `25af1e5` 的 145 项相关组合及 macOS 506 项均通过。两者生产差别仅为恢复查询的每 caller view 快照复制，新增一个回归后行为总数 507。

首次相关组合 `candidate-combination.log` 未通过：已有 pre-parse socket 100ms 断言首败，未更改该 deadline 或断言；旧 SQLite 关闭 fixture 先 await close 再释放挂起 read，与本轮“关闭必须等待原 read”的要求冲突而挂起。只调整该 fixture 为启动 close、确认仍 pending、释放原 read、await close、确认原 query denied，保留原最终授权／物理输出断言。仅终止本轮两个测试 PID，未记通过。`candidate-combination-corrected.log` 原组合 **145/145，0 fail/skip**，包括原 pre-parse 用例；首败证据不删除，也不据重跑推断根因已解决。

`270083b` 的 macOS 全套记录为 **507 项中 506 通过、1 失败**（`final-macos-270083b.log`），仍是同一 pre-parse 100ms fixture；该条失败后串接的 Linux 命令没有执行。另行独立执行 `final-linux-270083b.log` 为 **507/507，0 fail/skip**。为解决测试同步问题，仅在公开 clock.schedule 注入边界记录旧用例推进前是否注册 timer；`preparse-registration-probe.log` 实际观察到 `registered:false`，且同次 `raw_read_deadline_reset`，证明该次 fixture 在服务端注册绝对 timer 前就推进了时钟。随后只等待本连接的绝对 5000ms timer 注册，再按原 4999+1 推进；保留 100ms 观察上限、5 秒语义、进度不续期及零身份／业务调用断言，不改生产 timer、没有增加 sleep 或重试。另将 F02 child 的调查／关闭计量直接接入公开 Agent.run/close 边界。仅测试提交为 `b5c7efc2b3e2a99a53f6047a4227df0059dc8d2d`，生产字节仍为 `270083b`。`preparse-sync-and-agent-boundary.log` 三项通过。

生产检查点 `270083b` 的普通双轴复核完成，Standards **0 硬违约／0 有意义 smell**、Spec **0 确认 finding**，独立原文位于 `code-review-270083b.md`。它不替代先前中断的专门安全复核。

该检查点已执行的结果如下；最后的受理关闭失败补丁与新检查另附：

| 检查 | 实际结果与日志 |
| --- | --- |
| 项目类型／构建 | 通过；`final-typecheck.log`、`final-build.log`。 |
| macOS 全行为 | **507/507，0 fail/skip**；`final-macos-b5c7efc.log`，Node24.22.0、concurrency2、test host timeout15s。 |
| 受限 Linux 全行为 | **507/507，0 fail/skip**；`final-linux-b5c7efc.log`；同一固定 Node config、无网、只读 root/checkout、512MiB、pids64、64MiB tmpfs、concurrency2、test host timeout15s。 |
| 自有完整声明闭包 | bootstrap main、MCP boundary、Kibana、CBM evidence、管理 snapshot 的 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`skipLibCheck:false` 通过；`final-own-strict-corrected.log`。 |
| 严格 consumer | Pi 正例通过、负例恰为 TS2322（vendor body 既有 skip 例外保持）；Teams 完整声明 strict 正例通过、负例恰为 TS2769；`final-pi-consumer.log`、`final-teams-consumer.log`。 |
| Teams 本地互操作 | 实际签名 service route、OAuth404 与成功/429/reset 各一次物理 POST，通过；`final-teams-interop.log`。 |

严格检查的首次命令额外把 Teams vendor 完整声明叠加进自有 `exactOptionalPropertyTypes` 组合，固定 `JsonWebToken.d.ts` 出现 TS2420（`final-own-strict.log`），该命令记失败，不记通过。后续按既有分工验证：自有 bootstrap/MCP/Kibana/CBM/管理闭包保留所有严格开关；Teams 使用原 `scripts/check-teams-types.mjs` 完整声明 strict 正负 consumer。未修改依赖或项目检查配置，也不声称 Teams vendor 在额外 exactOptional 组合通过。

```sh
node node_modules/typescript/bin/tsc --ignoreConfig --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --target ES2024 --module NodeNext --moduleResolution NodeNext --types node --skipLibCheck false --noEmit src/bootstrap/main.ts src/adapters/mcp/boundary.ts src/adapters/kibana/logs.ts src/adapters/codebase-memory/evidence.ts management/codebase-snapshot.ts
node scripts/check-pi-types.mjs
node scripts/check-teams-types.mjs
node scripts/check-teams-interop.mjs
```

joined native **3/3，0 fail/skip**（`final-joined-native.log`），使用实际固定 Pi、Kibana/CBM 和签名 Teams、loopback 合成来源；显式配置为 `/tmp/bau-spec14-context/kibana-test-artifact.json`，fixture 只覆写 loopback 与合成 key。没有启用真实来源。实际命令：

```sh
BAU_KIBANA_TEST_ARTIFACT_CONFIG=/tmp/bau-spec14-context/kibana-test-artifact.json node --test --test-concurrency=1 --test-timeout=65000 dist/tests/contracts/codebase-kibana-native.test.js
```

根代理在 `b5c7efc` 检查点编译结果再次独立回放：`root-f01-independent-b5c7efc.log` 仍为 32 客户端断开、原 read 未结束且仅 1 flight、独立已完成案件 HTTP 200；`root-original-f02-f03-b5c7efc.log` 仍为混合精度 `.500Z`、40 案在宿主关闭前后 retained 均 0、调查 0／Agent.close 40。R01 原公开请求与第三次 delivery 查权撤权顺序保留，仅接入同一 authority 的 current 能力并替换 import；`root-identity-denied-b5c7efc.log` 为 revoked=true、物理输出仅 status，`root-identity-allowed-b5c7efc.log` 为 revoked=false、物理输出 status+simulator。两次本地 HTTP 断言通过，Postman exit 均 0；允许对照存在报告不表示撤权后仍发送，没有采用探针中该字段名称作相反结论。

## 99f75db 中间镜像（历史检查点）

真实构建器以 clean Git archive `99f75db5d56dcb1b9d9226eedb3db5b4d6723714` 为来源实际构建成功，显式取消 BAU_IMAGE_DOCKER override，使用默认 `/usr/local/bin/docker`，没有复用标签的可变身份作为证据。新目录为 `/tmp/bau-image-rereview-710-99f75db5d56dcb1b9d9226eedb3db5b4d6723714/`，保存实际 `source/`、iidfile、inspect、build log、Docker save archive、inventory、OCI layout 和 receipt。历史 `/tmp/bau-image-review-a13-77b36f729c04562cdf3f38cecbd8e3ec7ee9f8a3` 未覆盖，不作为本轮来源证明。

| 身份 | 实际值 |
| --- | --- |
| Source commit / revision | `99f75db5d56dcb1b9d9226eedb3db5b4d6723714` |
| Source archive SHA256 | `4b927cb56dc36499a61c4377bccdc3422f2154e59b952a76908379f9a8714d91` |
| Docker config / iidfile | `sha256:0921baf529ddc2fc66f2476f61c2e1dceee5fa641df8f54329924e1b537ff5b9` |
| OCI manifest | `sha256:f09becf437b0f3a508b7a06da285fa7e6e6db49f27ec487b37b9b038a594ec6d` |
| OCI index | `sha256:81ebbb08744935cc730dada5db1f4e337f6eac02b62222a8fe2a5c35ec89e2d6` |
| Docker save archive | `sha256:fce98201390f252f9559016315171365a25a1ed94e5d4ba18193aff08a2d888b` |
| Inventory SHA256 | `63756eed1c65803eacc04f260253471fd71dd3407d2da1629410365b59ce4874` |
| Lock SHA256 | `e77e5783fa35a84b5d110111d337e13198bdde93b3db67453ec2ecf32db42ecc` |
| Runtime Skill SHA256 | `e204643dabd38e47d884b5aee74846b060e18fee46a50b3a6ddfd336f3d16a69` |
| 平台／工具链／应用文件 | `linux/arm64`、Node24.22.0、TypeScript7.0.2、65 个 JS 与实际 inventory 逐字节匹配。 |

`final-image-build-99f75db.log` 实际构建通过；`final-image-contracts-99f75db.log` 原容器／OCI 合同 **6/6，0 fail/skip**，使用上述不可变 config ID 与实际 OCI layout，覆盖非 root／无网／只读／资源上限、存储拒绝、两个场景、重复键与预算、取消／超时／未知关闭、审计失败、OCI 内容链与篡改拒绝。`final-image-source-99f75db.log` source canary **1/1**，忽略的额外 TS／陈旧 JS 均不进入 archive 编译，实际镜像 65 个 JS 与固定来源逐字节匹配。只清理合同自有容器与 volume，没有 registry 上传或部署；最终 `final-owned-containers.log` 与 `final-owned-volumes.log` 均无该合同前缀残留。根代理另只读核对 config／inspect revision／inventory 实际散列与 source 的 65 项清单、字节数及 SHA 均一致；与旧 `77b36f7` 镜像相比，只有 Teams host、troubleshooting application 和 Simulator domain 三个 JS 改变，符合本轮源码范围。该制品保留为当时通过的中间检查点；随后受理关闭失败补丁改变了应用字节，它不再作为本轮最终 runtime 证明，新镜像另附。

```sh
env -u BAU_IMAGE_DOCKER node scripts/build-image.mjs /tmp/bau-image-rereview-710-99f75db5d56dcb1b9d9226eedb3db5b4d6723714
BAU_CONTAINER_IMAGE=sha256:0921baf529ddc2fc66f2476f61c2e1dceee5fa641df8f54329924e1b537ff5b9 BAU_OCI_LAYOUT=/tmp/bau-image-rereview-710-99f75db5d56dcb1b9d9226eedb3db5b4d6723714/oci node --test --test-concurrency=1 dist/tests/contracts/container-runtime.test.js dist/tests/contracts/image-oci.test.js
BAU_IMAGE_INVENTORY=/tmp/bau-image-rereview-710-99f75db5d56dcb1b9d9226eedb3db5b4d6723714/inventory.json node --test dist/tests/contracts/image-source.test.js
```


## 迟到受理关闭失败的补充核实

最终收据之后的只读自查发现另一个 F02 组合边界：宿主开始关闭时 confirmed admission 尚未返回，迟到 candidate 不在原 active 快照；closePhase 虽被 controlWork 等待，若其 Agent.close 明确失败，通用 controlWork 的 allSettled 会吞掉拒绝，从而仍报告 closed。公开 A/Agent 故障探针 `f02-late-close-failure-probe.log` 实测 closeAttempts=1、status=closed。永久回归 `f02-late-close-failure-red.log` 得到 Missing expected rejection；只在调查前的统一关闭分支锁存 admissionCloseFailed，并在宿主关闭末尾检查该位，保持失败为 unknown，而不把可容忍的终态读拒绝升级为宿主关闭失败。`f02-late-close-failure-green.log` **7/7**，覆盖原 close 失败、两种各 40 案 GC、未结束 distinct 读、实际 Teams pre-ACK unknown 和 32 断开请求的正常 HTTP 对照；项目类型／构建通过（`final-typecheck-late-close.log`、`final-build-late-close.log`）。

最终生产检查点 `c8a96e497b3e6f51d2ad212b89270051f57db7d4`，总行为数 **508**。macOS **508/508**（`final-macos-c8a96e4.log`）、原相同受限 Linux **508/508**（`final-linux-c8a96e4.log`），均 0 fail/skip；最新自有完整严格闭包通过（`final-own-strict-c8a96e4.log`），项目类型／构建日志见上。Pi／Teams 依赖及 consumer 未改变，正负 consumer 与互操作仍以本轮 b5 的实际结果为检查点，不冒称重新执行。

此增量的普通 Spec／Standards 复核均 **0 确认 finding／0 硬违约／0 有意义 smell**（`code-review-c8a96e4.md`），确认该失败位在受跟踪原 Promise 结束前锁定，普通 read 的拒绝不设置该位；它与 `270083b` 的两轴结果一起覆盖本轮完整代码。b5 的原 F01/F02/F03 和 R01 独立回放保留为该组检查点，c8 后续仅改变调查前 Agent.close 失败传播。最新 joined native **3/3，0 fail/skip**（`final-joined-native-c8a96e4.log`），与上轮完全相同固定制品／loopback 合成配置。根代理用同一独立公开 A probe 对 99f75db 的实际 source/tree 编译基线与 c8 候选复验：`root-late-close-failure-baseline99.log` 为原 closeAttempts=1、调查=0 却 closed；`root-late-close-failure-c8a96e4.log` 为 closeAttempts=1、调查=0、unknown。双方均确认原 confirm 未 settled 时 shutdown 仍 pending；探针直接调用 A 的 application.close，将成功 resolve 记作 closed、rejection 按宿主契约映射为 unknown；这条探针没有启动真实 Teams 宿主，不声称直接实测 host.stop。两个脚本 exit 0 代表对应预期观察成立，基线脚本断言的是已知 bug 现象，不能记成缺陷检测已通过。最终固定 archive 镜像及实际合同如下；99f75db 仅作历史检查点。

## 最终实际镜像与收据

本轮最终实际构建从 clean Git archive `300c1636ee0edaf00c8f11195c63c897e017756f` 编译，生产字节等于 `c8a96e4`。显式取消 BAU_IMAGE_DOCKER override、使用默认真实 Docker，fresh 目录 `/tmp/bau-image-rereview-710-300c1636ee0edaf00c8f11195c63c897e017756f/` 保存全部实际 build／source／inspect／iidfile／Docker archive／inventory／OCI／receipt。旧 99f75db 制品保留，未覆盖。

| 身份 | 实际值 |
| --- | --- |
| Source commit / revision | `300c1636ee0edaf00c8f11195c63c897e017756f` |
| Source archive SHA256 | `689cb4c3b6034e19ae88e7f03ebf2b4555f2d54505bdb05858e16a2b492f9927` |
| Docker config / iidfile | `sha256:34f68e9fc5f7f427d45ba69c0cd3e1ec1789dddf65b521d0c0fe26161fd32e07` |
| OCI manifest | `sha256:b6f238adf87a0dc83aa07f1c8d1df9a30c4b82a9e3a9ee0b5ab4f4ac121113c0` |
| OCI index | `sha256:fdbd22bf1dbcaa15d68229dddbeec4473c87cdb9629c80a4d2ba89bd46cc6866` |
| Docker save archive | `sha256:ce2f19585c3807a294d8f0c567021079ab30b2877929aec2143f81bc0542ec12` |
| Inventory SHA256 | `a5679bfb88d07087f43c31600bb9f95e788114bbbfbf9692f5adc1f679a5f568` |
| Lock SHA256 | `e77e5783fa35a84b5d110111d337e13198bdde93b3db67453ec2ecf32db42ecc` |
| Runtime Skill SHA256 | `e204643dabd38e47d884b5aee74846b060e18fee46a50b3a6ddfd336f3d16a69` |
| 平台／工具链／应用文件 | `linux/arm64`、Node24.22.0、TypeScript7.0.2、65 个实际应用 JS。 |

`final-image-build-300c163.log` 构建 exit 0；`final-image-contracts-300c163.log` 原实际容器／OCI 合同 **6/6，0 fail/skip**；`final-image-source-300c163.log` source canary **1/1，0 fail/skip**。使用上述不可变 config ID，保留非 root／无网／只读／资源与存储拒绝、两个场景、重复键／费用、取消／超时／未知关闭、审计失败、OCI 内容链／篡改拒绝及忽略额外 TS／陈旧 JS 的原断言，最终实际 inventory 的 65 个 JS 与固定 archive 编译逐字节匹配。根代理独立只读核对 config／inspect revision／实际 inventory 散列与 source 清单均一致；对中间 99f75db 制品只有 troubleshooting application 一个 JS 改变，符合新增关闭失败传播范围。`final-owned-containers-300c163.log`、`final-owned-volumes-300c163.log` 无合同前缀残留；没有清理其他既有容器或卷。

```sh
env -u BAU_IMAGE_DOCKER node scripts/build-image.mjs /tmp/bau-image-rereview-710-300c1636ee0edaf00c8f11195c63c897e017756f
BAU_CONTAINER_IMAGE=sha256:34f68e9fc5f7f427d45ba69c0cd3e1ec1789dddf65b521d0c0fe26161fd32e07 BAU_OCI_LAYOUT=/tmp/bau-image-rereview-710-300c1636ee0edaf00c8f11195c63c897e017756f/oci node --test --test-concurrency=1 dist/tests/contracts/container-runtime.test.js dist/tests/contracts/image-oci.test.js
BAU_IMAGE_INVENTORY=/tmp/bau-image-rereview-710-300c1636ee0edaf00c8f11195c63c897e017756f/inventory.json node --test dist/tests/contracts/image-source.test.js
```

此来源 pin 后只追加交付收据文档；没有 registry 上传、远程拉取验证或部署。本轮自身 `git diff --check` 通过，旧历史许可证原文检查限制不变。

## 范围与未执行项

可选 AbortSignal 是与既有 get beforeDisclose 类似的可信宿主技术参数；Teams JSON、模型、A–D 业务输入、操作和结果均未新增字段。新增取消接线适用于已回收上下文的记录恢复路径，不重新定义正在调查中的业务取消。

本轮没有新增／升级依赖。固定 Node24.22.0、TypeScript7.0.2、Pi1.3.0、Teams2.1.1、MCP1.32.1、CBM0.12.1；依赖没有变化，不把重新查文档当作新的运行证据。原 native snapshot 14 项、局部协议 9 项及镜像交错 1 项的先前结果保留为历史证据，本轮不冒称重跑。原 42 项 Pi 上游 TS1543 声明限制及窄 skipLibCheck 例外继续保留；自有完整声明闭包／正负 consumer 分别验证。许可证原文 CRLF／末尾空行导致的历史整段 diff 检查限制不改变，本轮自身 diff 另查。

先前专门独立安全候选复核因工具内容审查中断，仍是未完成；本轮普通 Spec／Standards 复核不替代它，不声称该限制已解除。

未执行真实模型／公司网关／真实 Teams 租户／生产日志／内部 GitLab／G2–G4、注册表上传、部署或真实访问。#14、#30–32 继续保持 OPEN，无 Go；Mock、局部协议或镜像通过不构成真实联调完成，也不据此关闭父规格。
