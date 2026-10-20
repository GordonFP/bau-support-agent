# #23 原生 Pi 会话与受控排障 Skill

实现 [#23](https://github.com/GordonFP/bau-support-agent/issues/23)，基于集成 `497d42a`，交付前再次合并最新集成，结果 already up to date；保留 #21／#22 的模型与独立 MCP 契约。测试复用已确认 A–D；没有新增公开操作、私有测试入口、Pi CLI 子进程或 #24–26 实现。验证日期为 2026-10-21。

## 原生会话与唯一出口

- `createPiRuntime` 实现现有 `AgentRuntime.run/abort/close`。每案／phase 独立实际 `createAgentSession`、ModelRuntime、内存凭据／模型／设置／SessionManager、工具闭包、取消及任务集合。`modelsPath:null`、`refreshOnCreate:false`、`allowModelNetwork:false`；显式 model、ResourceLoader、工具允许列表与固定 opaque cwd，未使用默认全局用户文件／项目发现／资源／Extension／动态追加／持久会话。
- 两个 native provider API 均是同一个宿主 facade；完整实际 SDK `TranscriptContext.messages` 翻译为已有中立 ModelTurn，包括 system sections、工具声明／移除、历史、工具调用 ID／参数及结果／details。宿主追加当前确定性报告草稿。每轮只调用该 phase 的 `RuntimeRequest.generate`；facade 没有 HTTP、凭据查找、模型切换或直接供应商路线。费用和尝试仍只由已有 ModelGateway／C 总账控制，Pi 的零占位 usage 不作费用证据。
- compaction、SDK／provider retry、cache warming、prompt templates／命令及资源发现关闭。只有 `logs_read`／`code_search` 空参数 customTools，映射既有 request.invoke，经独立 MCP 完成当前授权、限量、净化和审计后才交回 Pi。部分／未知参数、未列工具、审计故障和敏感源不能继续模型或报告。subscriber 仅接收有限生命周期进度；异常被安全收敛，不能打断 SDK settled 或承担授权职责。
- 普通 `memory_mock` 仍无网络；显式 `local_protocol` 经 #21 的原生 Responses gateway 访问本地服务。实际 Pi→两项独立 MCP→模型工具往返→C／D 报告需要三次完整受控模型请求，十店中九家齐备、一家缺失；第三次请求保留两项不同 call ID 及对应工具结果。领域 finish、证据归属及固定目的会话校验保持宿主权威。

## 生产 Skill

唯一审核制品为 [runtime-skills/bau-troubleshooting/SKILL.md](../../runtime-skills/bau-troubleshooting/SKILL.md)，SHA-256：

```text
27b86d3f62c99d366999fd07cb0651f04b9477206d0d204255f3f7680ae0258e
```

宿主以固定文件句柄读取普通文件，拒绝 symlink／非文件，以 stat 初筛并实际读取最多 16 KiB+1 后拒绝越界，再验证摘要及严格 UTF-8。完整正文一次读取后不可变地放进 SDK system prompt；`getSkills()` 为空，避免只广告路径或由 `/skill`／通用 read 懒加载。变更、超量、非法字节及 FIFO 均在 SDK／发送前拒绝；加载后修改或删除文件不能改变实际模型正文。

Skill 保留全部提交店铺、提交日期、授权及连续覆盖、齐备与测算执行的区别，要求事实／推断／未知、证据、局限与人工下一步。正文不限定店铺数量，不装入开发 Skill／AGENTS；提示词不替代宿主权限。环境项目的恶意 AGENTS、Skill、扩展、auth／settings 与开启默认工具的配置既未进入上下文，也未产生会话文件；实际请求只包含固定 opaque 运行信息，没有真实宿主路径。

## Settled、停止与删除

实际等待 `session.prompt`、`waitForIdle`／`agent_settled` 及本案任务；不把 `agent_end` 当作全部副作用结束。abort／close 幂等缓存原始清理 Promise，清理后移除 listener、SDK transcript／内存 session 及闭包。宿主在终态清除原入站／原值映射；未确认结束的工作继续受控保留，不能假称删除完成。

应用记录每 phase 的原始 guarded work、终态视图写入、未知结算／审计和停止审计，原 abort 与 raw close 结果按原 phase 缓存。五秒限制只结束调用方等待，不能把原 Promise 改为成功或遗忘。停止应答可及时返回，但 C 删除等待原工作确实结束；任一清理 handler 失败也不会丢掉其他尚未结束的 handler。原 abort 失败仍使收据 partial，即使后来另一次 abort 看似成功。

补问时先使旧 phase 失效，记录并启动原 abort，再退出正在执行的工具；避免“工具等待 abort、abort 等待工具”的自等待。可信回复建立全新原生 phase，旧工具历史不进入新会话；证据、费用、次数及来源映射仍按原案规则累计。实际第二候选恢复需要四次累计模型尝试；取消 A、A 的晚到物理响应及清理不影响 B 的模型／工具／报告。

已结束本地任务与未知外部执行分别处理：实际两次网络 reset 经宿主唯一重试后，SDK 真正 settled；SQLite 可以删除业务记录，但两笔未知执行槽、360,000 microusd 及原 binding 跨删除／重启保留。伪造 binding 拒绝，原 C 调用可在删除后幂等结算，最后 3,500 microusd／零槽，不恢复记录／调查／发送。

## 实际验证与限制

固定依赖、27 个新增制品的 SHA-512、许可证／公告及类型限制见 [依赖增量](protocol-dependencies.md)。本次 coding-agent 根声明闭包实测存在 42 个上游 TS1543；`skipLibCheck:true` 仅跳过第三方声明体，strict 项目源检查保持。合法 SDK 消费端通过、错误 tools 类型仍被 TS2322 拒绝；没有将失败的全声明检查记通过。

- macOS arm64：完整 262 项行为测试通过，包含原有 249 项及本票 13 项实际 SDK／生命周期行为。
- 受限 Linux arm64：相同编译产物完整 262 项通过，实际执行 coding-agent 根 SDK、本地模型、两个 MCP 进程、SQLite／重启／删除及 FIFO；无外部网络、只读根／代码，临时目录 64 MiB、512 MiB、pids=64、测试文件并行度 2。
- 两项原有 Postman CLI 1.74 实际协议回归重新通过；本票原生 Pi 闭环使用 Node 本地 Responses 服务，未把 Mock runtime 的 Postman 结果冒充 Pi 会话证明。
- 独立类型检查、构建、严格消费端正／负例、差异、文档本地链接及 Skill 摘要检查通过。额外 Linux 公共模块加载清单配合本票 13 项测试，确认当前文本路径不依赖缺失的平台 native／WASM 执行能力。

TDD 真实失败后修复：FIFO 无限等待、SDK subscriber 抛错中断 settled、已 settled 仍有网关续作却错误删除、handler 失败遗漏其他待清理工作、终态写入／未知审计／停止审计未受跟踪、补问自等待及原 abort 错误被忘记。初次全套曾暴露等待 ACK 的旧 Mock 取消回归，已分离应答与 raw cleanup 后重跑；两项旧删除测试原先在模型 Promise 未结束时断言 deleted，现增强为 partial→原工作结束→deleted，并新增删除后未知总账的独立持久证明。早期测试 harness 的已拒绝入站仍等待 close、控制包装递归和 SQLite 错误归一化预期也已纠正，失败不记通过。

```sh
export PATH=/tmp/node-v24.22.0-darwin-arm64/bin:$PATH
npm run typecheck
npm run build
node scripts/check-pi-types.mjs
node --test dist/tests/behavior/*.test.js
# POSTMAN_CLI 指向已核验的本地 CLI 1.74。
node --test dist/tests/contracts/model-postman.test.js

docker run --rm --pull=never --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m --memory=512m --pids-limit=64 \
  --mount type=bind,source=/tmp/bau-spec14-worktrees/issue-23,target=/app,readonly \
  --workdir=/app \
  node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 \
  node --test --test-concurrency=2 dist/tests/behavior/*.test.js
```

未验证且继续关闭：真实模型／CPA／公司路线、别名映射、收费／tokenizer／reasoning／输出保证及数据政策，真实 Teams、Kibana／CBM 制品与底层 ACL、生产／GitLab、历史样本质量；图像／TUI／CLI／WASM／沙箱能力不启用。#15 Node 更新通知、签名信任链、完整 notices 和最终镜像／存储门禁仍未完成。本地 G1 通过不关闭真实联调票或父规格 #14；没有推送或 tracker 操作。
