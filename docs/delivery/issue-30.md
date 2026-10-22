# #30 本机 CPA 前检与合成接入

2026-10-22（Asia/Singapore），基于 `codex/poc-integration@1b2a8e3c4c6994dfc84405ef7167dc7d83242975`。用户明确授权检查和接入本机 CPA，随后明确决定：“先放开，看 POC 结果在评估一个合适的控制。”该调整适用于本轮合成开发 POC 的 4k 输出硬上限；不会自动扩大到业务数据、公司网关、真实 Teams、其他模型或正式部署。

**当前结果：实际 CPA + Pi SDK 已完成 Simulator／PSP 两个合成案件，报告、交付收据、token 用量和未知费用账本均保存。** 单次 4k 生成上限按用户决定改为观察；[原 #30](https://github.com/GordonFP/bau-support-agent/issues/30) 的完整验收仍未完成，不能以两个成功样本关闭本票或父规格。

## 本轮政策与使用入口

- 独立 `cpa_poc` profile，`cpa-poc-output-observation-1` 契约；应用模型仍为 `gpt6.1-sol`，显式映射到 CPA 的 `gpt-6.1-sol`。不自动换模型／供应商。真实 CPA 不再发送 4k 参数，也不因本地合成 byte-pair 输出超过 4k 拒绝正常结果；Mock／local_protocol 保留原来的严格 4k 契约。
- 输入在发送前使用完整 canonical JSON 的 UTF-8 字节数加 2048 的保守准入计量，最多 24000；返回的上游 input usage 超过 24000 时终止案件。此方法不是实际 GPT tokenizer 的完整 24k 容量证明，额外余量也不是供应商转换上界证明。
- 保留原有授权、净化、持久输入／意图、60 秒单次／原始重试共同期限、180 秒轮次期限、每案最多六次、全局两项未知执行容量和每分钟六次起调控制。
- 每次使用 US$0.18 的**规划预留**；每案 US$2／POC US$100 仍约束账本准入。这不是当前无输出硬上限路线的实际收费上界。真实金额缺失时始终保留预留；token usage、Pi 的本地零费率和模拟 usage 字段都不会结算成免费。确认终态只释放执行容量。
- 保留 1 MiB 网络响应／结构结果资源边界；它不是生成前 token 或费用上界。reasoning 只记录供应商返回的 token 数，不将内部推理文本写入案件。
- `scripts/run-cpa-poc.mjs` 自动启动固定 SHA256 的独立 CPA **8.0.38**，使用随机本机客户端／管理 key、独立 loopback 端口及工作目录；全局重试为 0、每轮最多一个凭据、stream bootstrap 重试为 0，关闭图片生成注入、管理 UI、插件、请求日志和使用聚合，使用本地模型目录。启动后经带鉴权的本机 `/v8/management/credentials` 元数据确认只有一个 Codex 账户、无正数凭据重试覆盖、未启用 WebSocket；不读取 token 下载接口，不打印账户标识。应用不解析或复制 OAuth token，不持有业务凭据。CPA 自身仍拥有 OAuth 读取／刷新能力。
- 运行入口只接受记录目录，固定运行公开合成 Simulator／PSP 样本。不能传入任意业务问题、身份、数据或资源。Pi 只加载原已审核 Skill 和两项空参数工具，日志／代码和交付仍是 Mock。原容器／生产入口仍仅启用 Mock；开发入口的成功不代表启用了 G3。

在仓库根目录、Node **24.22.0** 位于 PATH 时：

```sh
npm run build
node scripts/run-cpa-poc.mjs /absolute/private/poc-records
```

默认定位本机 EasyCLIProxyAPI 的内核和 OAuth 目录；可通过 `BAU_CPA_BINARY`／`BAU_CPA_AUTH_DIRECTORY` 指定路径，二进制仍须匹配本文固定 SHA256。不需要复制账户 token 或在命令行输入 key。保留同一记录目录可累计预算，重启不重放历史案件。Ctrl-C／SIGTERM 触发宿主关闭及自有 CPA 清理；本机日常 8317 实例与配置不手工修改。独立 CPA 工作目录（包括可能的错误请求日志）在退出时删除，合成案件的 SQLite 和两份 JSON 留在指定目录。

## 2026-10-22 用户升级后的价格接入

本机 GUI 已更新为 EasyCLIProxyAPI **0.3.51**，内核为 CLIProxyAPI **8.0.38**，自报 commit `0db19025`、BuiltAt `2026-10-21T15:07:26Z`。安装文件与本机缓存发行包中的内核 SHA256 一致：`9f613e38302bb2b798cb798910c4862757bc7ae2f5032ec6d872f170d27c9c84`。这是本机文件／发行包一致性，不声称发行签名或可复现构建验证。下文 8.0.24 的历史运行记录保留。

只读检查新版 GUI 的 `model_prices` 后，`gpt-6.1-sol` 及旧别名均无价格行。固定版本的管理路由也没有提供该模型的权威金额。未读取个人使用历史，未调用会消耗使用队列的接口，未改用户价格库。

费用模块启动时仅查询该模型的输入、输出和缓存读取单价及配置标志；三项完整有效时优先采用 CPA 配置。缺行、缺字段、无效价格或数据库不可用时，按用户授权使用当日核验的 [OpenAI 模型页](https://developers.openai.com/api/docs/models/gpt-6.1-sol)与[官方定价表](https://developers.openai.com/api/docs/pricing)：

| Standard 短上下文 API 等价估算 | US$/百万 token |
| --- | --- |
| 未缓存输入 | 2.00 |
| 缓存读取输入 | 0.10 |
| 输出（已包含 reasoning） | 10.00 |

计算为 `(input - cached) × inputRate + cached × cacheReadRate + output × outputRate`，以整数微美元向上取整。缺缓存细分时按全部未缓存估算；缺 usage 或细分矛盾时不生成金额。未报告的缓存写入、速度档位和附加费用不包含在该 Standard API 等价估算内。

模型输出记录保存金额、`cpa_configured`／`openai_official` 来源、价格快照引用和 `standard-api-equivalent` 口径；预算账本另存 `estimatedMicrousd`。**估算不是 Codex 账户账单，不填写 actual，也不释放未知费用预留。** 已确认供应商终态可释放执行容量。价格更新在下次启动读取，已保存的记录仍保留原快照。

新版内核的实际合成上游合同最初因额外注入 `image_generation` 被严格两工具断言拒绝。按[固定版本配置源码](https://github.com/router-for-me/CLIProxyAPI/blob/0db19025571684b198a2ef508f99b41c717337e8/internal/config/config_v8.go)设置 `multimedia.disable-image-generation: true`，没有放宽上游断言。503 会冷却单个合成凭据，各故障场景因此使用自己的独立内核，不增加凭据或隐藏重试。

`tests/contracts/cpa-core.test.ts` 使用实际固定内核、空 OAuth 目录、Postman 合成 Codex 上游和注入时钟。8 个场景通过（Node 报告含父测试 **9/9**）：60 秒／取消 fence、两路未知执行容量、503 单次、一次应用网络重试、每案六次、滚动每分钟六次、本地完整 canonical 输入计量恰好 24000 与下一字节拒绝、180 秒轮次期限。短输入用于次数控制，避免累计上下文先碰到输入限制；完整输入边界独立验证。重试保留第一次未知费用／执行占位，取消后不交付迟到结果。

该合同使用合成上游和人工时钟，不等同于真实供应商的全部隐藏尝试、停止生成／收费或真实完整 24k token 容量。固定内核计数源码对未知模型回退旧编码，不能据此声称 `gpt-6.1-sol` 精确 tokenizer 已验证；目前保留原保守输入准入。

### 新版实际模型闭环与估算结果

Node24.22.0／Pi1.3.0／CPA8.0.38 实际运行，新增 **6 次真实模型调用**，均使用固定合成输入及 Mock 工具／交付；不含新的独立付费协议探针。

| 案件 | 终态 | 调用次数 | 输入 token 总和 | 输出 token 总和 | 缓存输入 | 用时 | 官方 Standard API 等价估算 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Simulator | completed | 3 | 6238 | 1800 | 0 | 约 37.2 秒 | US$0.030476 |
| PSP | completed | 3 | 9658 | 59 | 1920 | 约 6.6 秒 | US$0.016258 |

合计估算 **US$0.046734**。六次 reasoning token 均为 0，未覆盖非零 reasoning 样本。两案实际费用继续 unknown，各保留 US$0.54、合计 US$1.08 规划预留；这些预留不等于本轮估算金额或实际账单。

私有本机证据目录 `/tmp/bau-cpa-upgrade-live-20261022-ypIdXy` 保存运行摘要、完整合成记录、报告、SQLite、重启与退出核对。宿主关闭为 closed，自有 CPA 进程数为 0。重新以相同授权资源范围经公开 C 读取，两案终态、估算／实际未知值、预留及逐次账本与原记录一致；记录中未发现原始合成敏感标识或客户端／OAuth 凭据。首次重读使用资源范围较窄的默认 Mock，被正确拒绝；恢复原范围后通过，没有放宽授权实现。

### 升级后的验证收据

- build、typecheck 通过；全行为 **530/530，0 fail/skip**。五项 CPA 行为覆盖长输出、账本估算、授权／完整输入控制、超限 usage、CPA 单价优先及缺失／无效回退。前两项新增金额断言先红后绿。
- 实际内核／合成上游 **9/9**，日志 `/tmp/bau-cpa-upgrade-native-v5.log`。前期失败日志保留：默认图片工具注入；503 后共享凭据冷却；长累计上下文先命中输入限制；探针使用未知本地错误导致错误分类不匹配。分别通过显式关闭注入、逐场景独立内核、将次数与完整输入分开、使用已有受控拒绝类别修正，没有删除失败断言或放宽业务控制。
- 受影响本地协议 **10/10**（Postman 7 项及独立 HTTP 3 项），Pi 严格 consumer 正例／负例通过。原 Mock／local_protocol 的 4k 与 UTF-8 断言保留。日志为 `/tmp/bau-cpa-upgrade-{tests,typecheck,protocols,pi-types}.log`；修改文件的 `git diff --check` 及入口脚本语法检查通过。未重新运行完整 CBM 原生索引套件或 Pi 第三方全部声明体检查，后者的既有上游限制不记通过。
- 原生模型真实生成与本地故障合成分别列证；真实完整 24k token、非零 reasoning、供应商取消后生成／收费和留存／账户适用条款仍未完成。#30、#14 均保持 OPEN，不构成 G3/G4 或 POC Go。

## 实际模型结果

使用本机已登录的 CPA 账户，全部输入、工具结果和身份均为公开合成内容。最初独立协议预检有两次真实请求：空参数 `logs_read` 调用、合成工具返回后的 `SYNTHETIC_OK`；随后应用完整闭环另有六次真实请求。总计 **8 次**，没有访问业务日志／代码、公司网关或真实 Teams。

| 完整应用案件 | 结果 | 模型次数 | 输入 token 总和 | 输出 token 总和 | 用时 | 费用 |
| --- | --- | --- | --- | --- | --- | --- |
| Simulator | completed，10 店铺／9 齐备／1 缺口；安全报告及交付收据已保存 | 3 | 7128 | 1361 | 约 36.2 秒 | unknown；保留 US$0.54 规划预留 |
| PSP | completed，保留 unsupported／not applicable 等独立业务状态；报告及交付收据已保存 | 3 | 10527 | 59 | 约 10.6 秒 | unknown；保留 US$0.54 规划预留 |

六次应用调用的 input usage 依次为 1309、2690、3129、1447、4322、4758，output 为 14、14、1333、14、14、31；均返回 reasoning=0，最后一轮 PSP cached input=2176。它们是供应商终态中的 token 数据，不是账单金额。两次独立协议预检另有 input 374／413、output 14／10，合计 US$0.36 的预检规划预留独立记在探针收据中，不冒称已并入应用 SQLite。主应用账本保留 US$1.08，全部八次规划占用合计 US$1.44，真实费用未知。

完整闭环运行使用固定 Node24.22.0、Pi1.3.0、实际 CPA8.0.24；宿主关闭为 closed，自有 CPA 已退出，日常 8317 服务保留。证据目录 `bau-cpa-live-20261022-8lvxvvep` 中有预检 `result.json`、应用 `app-result.json`、持久 SQLite 和每场景 JSON。初始两次辅助协议调用使用宿主 Node24.18.1，不冒作固定项目运行时验证。

以下前检记录描述**放宽之前**的失败和边界，不撤销该事实，也不将失败改记为通过。

## 本机部署与连接结果

| 检查 | 实际观察 |
| --- | --- |
| 管理应用 | EasyCLIProxyAPI 0.3.34。检查时未运行，已按接入请求启动。 |
| 实际内核 | CLIProxyAPI 8.0.24，帮助命令自报 Commit `091ff27f`、BuiltAt `2026-10-11T22:40:24Z`；安装二进制与本机缓存的 8.0.24 制品内二进制 SHA256 一致。没有升级或替换内核。 |
| 二进制 SHA256 | `ba0cd18bf7c4c12321c00888984823ab2048e90082ab776f290676184f36acdc`。只建立本机文件身份，不声称发行签名或可复现构建验证。 |
| 本机 API | `http://127.0.0.1:8317/v1`，只检查 `/models`。 |
| 无 key／错误合成 key | 均返回 HTTP 401。 |
| 已配置客户端 key | 返回 HTTP 200；key 仅在进程内读取并放入本机请求头，未输出、复制至证据或写入 Git。 |
| 实际模型列表 | 包含 `gpt-6.1-sol`；不包含原政策名称 `gpt6.1-sol`。真实启用时需要显式映射，不能靠自动模型回退。 |
| 现有重试配置 | 允许三轮额外重试、每轮凭据数不设上限；不能直接作为应用“最多一次网络重试”的运行证明。本轮没有手工修改日常 CPA 配置。 |

没有读取真实账户的 OAuth token 内容。用户 CPA 留在本机 8317 运行；本轮自行启动的隔离 CPA 和 Postman 模拟进程均已关闭。

## 实际内核与合成上游的验证

使用同一个已安装二进制，新建独立配置、空 auth 目录、全合成客户端／上游 key。监听独立 loopback 端口，Codex 上游明确指向自有 Postman 本地 simulation；使用内置模型目录，关闭管理面板、插件和额外重试，不加载用户 OAuth 目录。

配置只将原应用别名 `gpt6.1-sol` 映射到合成上游名称 `gpt-6.1-sol`。向隔离 CPA 发一个 `/v1/responses` 请求：

```json
{
  "model": "gpt6.1-sol",
  "max_output_tokens": 4000,
  "stream": true,
  "store": false,
  "input": [{"role": "user", "content": "SYNTHETIC ONLY: return OK."}],
  "tools": []
}
```

本地上游实际观察如下：

| 字段／行为 | 观察结果 |
| --- | --- |
| 实际请求路径 | `/responses`。 |
| 上游模型 | `gpt-6.1-sol`，合成别名映射成功。 |
| `max_output_tokens` | 不存在。 |
| `max_completion_tokens` | 不存在。 |
| `stream`／`store` | 分别为 true／false。 |
| 上游结果 | 采集完请求后主动返回 HTTP 400 `synthetic_no_generation`，不实现生成。该状态不是模型调用成功。 |
| 实际真实模型生成 | 0 次；不使用真实账户凭据，不产生供应商模型调用费用。 |

这与安装版本对应的[固定转换源码](https://github.com/router-for-me/CLIProxyAPI/blob/091ff27f31285ec4fd1dd5823b44f7f51fb8f48b/internal/translator/codex/openai/responses/codex_openai-responses_request.go#L14-L27)一致：转发前删除两个 token 上限字段。运行证据来自实际二进制的合成 API-key Codex 路径；没有冒称捕获过用户真实 OAuth 请求，亦没有验证真实 usage／计费或完整工具闭环。

受控本机证据目录为 `bau-cpa-preflight-20261022-l8nac56c`，包含 `probe.mjs`、合成配置、Postman simulation、采集字段、`result.json` 和仅合成日志。探针 exit 0 表示成功复现“不满足上限”，不表示 G2 通过。辅助探针使用宿主 Node24.18.1；它没有运行项目构建或将该版本冒作项目固定 Node24.22.0 的验证。

## 未完成的 G2 条件

- 4k 硬限制按用户决定在合成 POC 中延后评估；本轮两个正常样本不足以选定长期输出控制，亦不能证明断开后上游停止生成／计费。
- 实际完整 24k 输入、非零 reasoning、全部供应商／凭据内隐藏尝试、故障重试、取消后的上游执行状态、可靠收费口径、供应商侧留存／遥测和账户条款适用范围尚未完整验证。配置关闭额外重试不冒称这些行为已全部实测。
- 两个完整应用案例使用真实模型与 Mock 数据工具／交付；本地 Postman 合同使用模拟模型。两种证据分别记录，不互相替代。CPA 开发路线可执行，生产／容器默认门控继续关闭。
- 未进行公司网关、真实 Teams、生产日志、内部 GitLab或获准真实案例评估；#31/#32 的资料和批准边界不变。

#30 和父规格 #14 保持未完成。本轮不扩大至公司网关／真实 Teams／生产日志／内部 GitLab，不触发 #31/#32，也不构成 POC Go。历史中断的专门安全复核状态未改变。

## 本轮验证

- 固定 Node24.22.0：项目 build／typecheck 通过；全行为 **529/529，0 fail/skip**（原 525 项加四项 CPA 回归）。覆盖长输出观察、费用不被伪 usage 结算、授权／净化／完整输入／契约绑定拒绝，以及上游观察到输入超限后停止。
- 本地 Postman 依赖合同 **7/7** 通过，含新的实际 Pi／SQLite／两场景 CPA 合同；独立 HTTP 合同 **3/3** 通过。仅合成网络，没有将模拟模型计为实际 CPA。
- 协议首轮为 **8/10**：两个 standalone Responses fixture 因共享 server 拆为显式 CJS 后未复制依赖而启动失败。补齐 fixture 的依赖复制后，三项原始 HTTP 断言全数通过，没有删除 UTF-8 或 4k 边界检查。日志分别为 `/tmp/bau-cpa-20261022-protocols-initial.log` 与 `/tmp/bau-cpa-20261022-direct-protocols.log`。
- Pi 严格 consumer 正例接受／负例 TS2322 通过；实际模型六次完整闭环和两次协议预检见上文。SQLite 关闭后重新经公开 C 读取，两案均 completed、各三次未知费用／US$0.54 预留及 token 记录保持；敏感字段／客户端 key 检查通过。
- 独立 CPA launcher 的固定制品、单账户／无覆盖重试／SSE 元数据检查、启动及退出实测通过，额外模型生成 0 次。最初误用不存在的 `/v8/management/auth-files` 路径被安全拒绝；按安装版本[固定路由源码](https://github.com/router-for-me/CLIProxyAPI/blob/091ff27f31285ec4fd1dd5823b44f7f51fb8f48b/internal/api/server_management_v8.go)改为 `/credentials` 后通过，没有降级成跳过检查。
- 首次完整应用运行后增加了输入 usage 超限终止、launcher 元数据 fence 和信号收尾；前者经红绿行为回归验证，后者经无额外生成的 launcher 实测与脚本检查验证，未为这些本地收尾变更重复付费运行同样的八次模型请求。

`/tmp/bau-cpa-20261022-tests.log`、`-typecheck.log`、`-pi-types.log` 保留本轮检查输出。完整真实 24k／故障取消／上游全部费用与留存、公司 G3 和 G4 均未执行，不记通过。旧镜像不作为本次源码的制品证明。

## 本次固定来源镜像

从 clean `29e5e36afa186520b04f5b2dfcfe7741365f48a9` 实际重建，制品位于 `/tmp/bau-image-cpa-20261022-29e5e36`；没有部署或上传 registry。来源 pin 之后仅追加本交付收据，不改变应用 JS。

| 项目 | 本轮结果 |
| --- | --- |
| Docker config ID | `sha256:d72ff1bdddd7d73ed69673a0cadac883a875bd5a758a89e9e4375facee4a9c42` |
| OCI manifest | `sha256:f045f5cdcff8590fbe40030c45d83879827c28b0e292548415ef34084026c2e2` |
| OCI index | `sha256:65e502e07555c889eb31f968bc103d3500635e475b0fbac2ba13d208d1ea59db` |
| Docker save archive | `sha256:983b98b79b95d49ea9a67aa0baffcbf9375ad806816da21454df40f5308815b3` |
| Git source archive | `d1476c37ea7e424ffe49a9cfab5d4bc3670aa42f6049027f2aebfbb2ceb2e0a0` |
| 实际来源一致性 | Linux/arm64、Node24.22.0／TS7.0.2；72 个 JS 的路径／字节数／SHA256 与固定源编译逐项一致 |
| 容器／OCI 合同 | **6/6，0 fail/skip**，原无网／非 root／只读、两场景、账本、取消／超时／未知关闭和审计／OCI 断言保留 |
| 忽略 TS／陈旧 JS source canary | **1/1，0 fail/skip**；首轮因子进程 npm 沿用宿主 Node24.18.1 而安全拒绝，补充固定 Node24.22.0 的 PATH 后通过，没有改断言 |

日志为 `/tmp/bau-cpa-20261022-image-{build,contracts,source}.log`；首轮 canary 失败另保存在 `-image-source-initial.log`。未重新运行完整 Linux 529 项或未受影响的 CBM 原生索引合同；不把先前证据记为本轮执行。Pi 上游完整声明的既有 TS1543 限制不记通过；本轮验证的是项目类型及严格 consumer。
