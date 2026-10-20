# #21 唯一模型出口与本地 Responses 协议

实现 [#21](https://github.com/GordonFP/bau-support-agent/issues/21)，复用父规格 #14 已确认的 A–D 边界。起点为 `918c38c`，交付前合入集成 `67a3bc5`，保留 #22 的 MCP、嵌套审计故障处理及九项日历回归。验证日期为 2026-10-21。本票不实现 #23 的 Pi AgentSession。

## 实现及验收证据

- 普通 `memory_mock` 保持无网络。宿主必须显式选择 `local_protocol`，才可装配固定 `synthetic-responses-byte-pairs-1` 的 loopback HTTP 服务；审计分别记录两个 profile／制品版本。CPA、公司及以普通 Mock 名义发 HTTP 的配置拒绝，不自动换供应商、模型或直连。保留 `gpt6.1-sol`，仅作合成别名，不声称实际部署映射。
- 现有 B `ModelGateway.generate` 接受应用自有完整 `ModelTurn`，包含 system、分节指令、历史、工具声明／移除、工具参数及结果，返回中立 assistant 消息。SDK 类型只在 Adapter。使用 pi-ai 1.3.0 公开 `api/openai-responses.streamSimple`、`normalizeContext` 和注入 fetch，实际运行 Responses 工具往返，不使用 Chat 示例。固定两个只读工具及闭合空参数 schema；分块完整参数可调用，未完成、未知／多余参数、错误或缺终止事件均拒绝。领域 `finish` 继续校验确定性报告、证据与固定目的会话。
- Adapter 只在 SDK 完成原生序列化后调用强制宿主 `beforeSend`。宿主核对 turn 摘要、协议／字段／工具、profile、敏感值、完整请求字节和 24k 限量，保存该精确请求与尝试视图，并在持久意图之后进入原有原子预算／两槽／滚动速率门禁。最终 admission 回调重新授权、检查 phase／deadline；其后无异步控制动作，立即发送相同不可变字符串。SDK、供应商隐藏重试与 cache retention 关闭；一次宿主尝试只准一次 fetch，HTTP redirect 拒绝。摘要、压缩、预热及其他供应商出口未启用。
- 本地合成 token 定义为 `ceil(UTF-8 字节数 / 2)`：输入计完整实际 JSON，包括所有协议字段；恰好 48,000 字节通过，多一个 token 零发送。上游在任何生成 delta 之前独立检查完整 `JSON.stringify({candidate, reasoning:""})`（工具轮为工具名／参数），最多 8,000 字节／4k；本 profile 不产生 reasoning。Postman 原生服务独立证明恰好 4k 可输出、越界返回 400 且零生成 delta。客户端响应校验是第二道检查，不能替代这项生成前保证。该定义只属于合成协议，不能推定 GPT tokenizer、reasoning 或真实计费上限。
- 原始 fetch 的有限网络错误代码可触发宿主唯一一次重试；SDK 错误字符串、HTTP 错误和 schema 错误不触发重试。重试保持原 operation／60 秒 deadline，使用不同 call ID，各次重新预留并计数。取消／首响应前超时实际中断本案连接，不影响另一案；排队消耗原 deadline。终止事件与费用分别判断：缺失 usage／codec 补零不证明收费为零，估算零仍保留预留；只有合成协议的显式 `mock_usage` 才作其本地费用依据。未知执行仍占槽，已知终止释放槽但保留未知费用；高于证明预留的实际报告保持真实数额并关闭后续 admission。
- 接收按实际已解压字节累计限制 1 MiB，UTF-8 严格解码，在 SDK parser 前生效；等待整个有界 body 验证完成后才交出结果，`[DONE]` 后的非法／超量尾流不能被忽略。响应、参数、usage、记录与审计均使用有限字段；原始上游错误不作异常消息外传。环境启用 `OPENAI_LOG` 且不为 `off` 时，SDK 构造前拒绝，避免环境打开原始 SDK 日志。合成秘密标记／私有路径扫描覆盖模型线协议、模型结果、错误、审计、记录、报告、交付和 Postman 日志；获准 B 来源查询仍按其权限在服务端处理。

## 本地协议服务与依赖

[OpenAPI](../../postman/responses.openapi.json)、[本地 mock](../../postman/mocks/responses/default.js) 和 [simulation](../../postman/simulations/model.sim.yaml) 是有限 Responses 子集。实际应用 A→B 原生 gateway→Postman CLI 1.74 服务选择日志工具、代码工具，再形成十店报告；三次真实请求与 C 留存的完整请求逐项一致，三次显式合成费用合计 3,000 microusd，十店中九家数据齐备、一家缺失。使用合成 runtime driver 驱动完整 neutral transcript；它不冒充 Pi AgentSession。

Socket reset、挂起、分块、取消与异常字节由额外 Node 本地服务注入。Postman 只在本地运行，没有登录、发布、workspace／云资源或真实凭据。测试监督自有进程组及有界日志，先 SIGINT，五秒仍未结束则 SIGKILL，并验证监听器已关闭；不声称 CLI 总能优雅退出。

固定依赖、公开 API、传递版本、SHA-512、许可证及安全公告证据见 [共享依赖记录](protocol-dependencies.md)。保留 `skipLibCheck:false`；没有 ambient shim、升级或放宽类型检查。该文档同时纠正 bignumber／data-uri 的许可证扫描遗漏，并保留 #28 的两项通知缺口及最终分发核验。

## 实际验证

精确 Node 24.22.0、TypeScript 7.0.2、@types/node 24.10.0 下：

- 独立类型检查、构建通过。
- macOS arm64 全部 245 项行为测试通过，其中本票新增 21 项原生／Mock 模型行为，保留集成的 224 项测试。
- 同一编译产物在受限 Linux arm64 全部 245 项通过；关闭外部网络、只读代码／根目录，使用临时可写目录、512 MiB／pids=64，测试文件并行度为 2。用例内部并发仍执行。
- macOS 上额外两项实际 Postman wire contract 测试通过：应用完整工具往返及上游生成前 4k 边界；Linux 没有执行 Postman CLI。
- `git diff --check`、交付文档本地链接、OpenAPI JSON 及 mock JavaScript 语法检查通过。

TDD 实测先失败后修复了：序列化字段遗漏、原始网络错误被 SDK 吞没、终止／收费混淆、完整 neutral Mock 翻译、usage 来源区别、非法 UTF-8、DONE 后尾流、环境日志、未完成工具参数，以及取消期间旧序列化回调修改已停止案件。最后一项现在在任何模型输入写入／计数之前重新检查原 phase／deadline。早期两次 Postman 测试的请求日志异步刷新及错误扫描范围属于测试 harness 问题，修正后重新执行；没有将失败算为通过。

```sh
export PATH=/tmp/node-v24.22.0-darwin-arm64/bin:$PATH
npm run typecheck
npm run build
node --test dist/tests/behavior/*.test.js
# POSTMAN_CLI 指向已核验的本地 CLI 1.74 可执行文件。
node --test dist/tests/contracts/model-postman.test.js

docker run --rm --pull=never --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m --memory=512m --pids-limit=64 \
  --mount type=bind,source=/tmp/bau-spec14-worktrees/issue-21,target=/app,readonly \
  --workdir=/app \
  node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 \
  node --test --test-concurrency=2 dist/tests/behavior/*.test.js
```

尚未执行且保持关闭：CPA／公司实际部署、真实别名映射／模型／收费／reasoning／tokenizer／输出与计费保证、真实数据政策、凭据／网络及真实模型工具闭环；真实源、Teams 和生产／GitLab 访问亦未执行。HTTP 压缩响应未单独验证，当前测试只覆盖未压缩 SSE；没有将本次结果记作任意 transport 兼容性证明。#15 Node 更新通知、制品签名信任链、分发通知和最终镜像门禁仍未完成。没有以本地通过关闭真实联调票或父规格 #14。
