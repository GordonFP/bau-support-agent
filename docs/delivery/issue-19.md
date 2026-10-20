# #19 — 原子模型预算、启动容量与未知费用

对应 [#19](https://github.com/GordonFP/bau-support-agent/issues/19) 与父规格 [#14](https://github.com/GordonFP/bau-support-agent/issues/14)。基于集成分支 `473dc1c`（含 #18 重复事件修复）；交付前再次合并 `codex/poc-integration`，结果 already up to date。验证日期 2026-10-20。

## 实现与验收

| 验收 | 实际可观察结果 |
| --- | --- |
| 原子费用与调用绑定 | 使用整数微美元，SQLite 同一事务检查每案 2,000,000、POC 100,000,000、每案六次尝试、两个未确认结束槽和滚动启动额度，再写原调用 ID。争用最后额度只有一个胜出；相同预留精确重放不重复扣费，改案件、轮次、案主、租户、会话、资源或冻结策略上下文复用调用 ID 被拒绝。账本独立于案件内容，取消、清理与重启均不清零。Mock 执行同一限制。 |
| 冻结价格规划 | 保留 2026-10-20 公开 USD 快照的 short/long、普通输入／缓存读取／写入、输出及 DeepSeek 类别，来源与未知项随版本固定。分类未知采用 long 写入价覆盖全部输入，不叠加互斥输入类别、不享缓存折扣；独立验证 24,000 × US$5/M + 4,000 × US$15/M = US$0.18，一案六次 US$1.08。规划快照与所选类别写入完整模型输入记录。 |
| 完整输入与总生成 | 服务端构造规范模型请求，包含系统提示、当前用户问题、此前模型回复、全部已接受工具结果、工具定义和生成参数；Mock 报告生成协议的工具定义固定为空数组，工具读取由外层 Agent 独立发起。B 在调用合成提供者前复核协议、字段、规范字节、token 上界及冻结规划；缺字段、多字段、未知转换／tokenizer／reasoning／隐藏尝试证明均拒绝。输入恰好 24k 可通过，多一个 token 在预留与生成前拒绝；输出和适用 reasoning 合计恰好 4k 可通过，超出拒绝且不退未知费用。 |
| 并发、速率与时钟 | 全局最多两个未确认结束调用，任意滚动 60 秒最多六次启动；费用已知但结束未知仍占槽，结束已确认但 usage 缺失可释放槽且保留费用。排队及控制等待计入原调用／轮次 deadline；上限 32 个等待位置，相同操作合并，满额拒绝新增。单调时钟决定窗口，UTC 仅作审计；UTC 前跳不能释放额度。持久逻辑时钟跨重启保留已知进度，未知停机时间不推进窗口，因此重启可能额外保守等待最多 60 秒。 |
| 最终启动授权 | 输入和视图先持久化，随后在每次最终启动检查当前授权和当前轮次／deadline，再原子占用容量；从原子放行到 generate 之间没有可等待的控制操作。排队期间或输入保存期间撤权时不预留、不生成，安全拒绝审计保留。控制超时结束本地等待，但未确认结束的控制继续占用有界位置；迟到授权不能启动模型。 |
| 重试与未知结算 | 只对网关明确标记的临时网络错误重试一次，沿用第一次的 60 秒 deadline，每次单独占用尝试／费用／容量，审计以原 operationId 关联；授权、契约、schema、审计、安全或普通异常均不重试，Mock 协议明确隐藏重试为零。缺 usage、失败、超时或取消保留原预留。实际、估算、未知及来源分别记录；零填充不等于免费，重复／迟到结算不能把已知实际费用改回未知或重复扣减。实际费用超过已证明预留时保留真实债务，停止当前报告并关闭后续新模型准入，重启后仍然生效。 |
| 迁移与故障 | 原生 schema 1→2 在事务中保留旧费用、尝试及未知执行槽；旧记录缺少可信启动时间时保守计入新窗口。可从原持久上下文证明的旧调用恢复绑定，无法证明的孤立记录继续保留费用／槽并拒绝冒名结算。预留提交及迁移提交故障均回滚；缺失持久时钟、未知／未来格式拒绝启动，不重建空账本。 |

模型预算与协议模块保持在现有 B/C 边界，应用只使用 `reserve/settle/status/generate`；没有新网络服务或模型可调用的预算管理能力。视图的 modelAttempts 在最终准入前保守保存准备次数，C 账本的 attempts 则表示已获原子准入的实际尝试；拒绝启动不会创建费用行。

## Mock 协议与真实启用边界

本票只允许 `mock-json-byte-pairs-1`：规范 JSON 是完整合成输入，转换为 identity，`utf8-byte-pairs-1` 明确定义每两个 UTF-8 字节为一个合成 token（不足两个向上取整）。输出按 `{candidate,reasoning}` 的完整规范 JSON 字节计数。测试以独立的 24,000／4,000 边界和实际交给 B 的请求验证，服务端复算而非相信模型自报 token。该定义只证明此 Mock 协议，不能据此推断 GPT、DeepSeek、CPA 或真实 tokenizer 的上界。

价格来源为已批准快照引用的 [Azure OpenAI 价格页](https://azure.microsoft.com/en-us/pricing/details/azure-openai/) 和 [Azure DeepSeek 价格页](https://azure.microsoft.com/en-us/pricing/details/ai-foundry-models/deepseek/)，本票没有刷新费率。short/long 阈值、实际 alias/SKU/区域、网关倍率／附加费／税、DeepSeek 写入类别仍未知。US$0.18／1.08 是该 token 假设下的公开价规划，不能当作公司实际全部费用上界。

真实协议转换、系统／历史／工具 schema 的最终请求、tokenizer、总输出含 reasoning、上游所有尝试和实际计费来源必须在对应接入票验证；第三参数 canonicalInput 须成为后续网关的实际出站载荷依据，不能再追加未计数内容。没有这些证明不发起真实调用。当前未接入真实模型、Teams、Pi、MCP、生产日志或 GitLab；不据此关闭父规格。

## 实际验证

沿用 [#15 工具链核验](issue-15.md) 与 [#18 SQLite 原生验证](issue-18.md)：Node.js 24.22.0、TypeScript 7.0.2、@types/node 24.10.0；macOS arm64 原生 SQLite 3.53.4。没有新增或升级依赖。

```sh
export PATH=/tmp/node-v24.22.0-darwin-arm64/bin:$PATH
npm ci --ignore-scripts --offline
npm run typecheck
npm run build
npm test
git diff --check
git merge codex/poc-integration
```

- 离线安装、独立类型检查、独立构建及差异格式检查通过；本地安装输出 0 vulnerabilities，不代表新的在线公告适用性复核。
- macOS 137 项行为测试通过，包含此前 104 项及本票 33 项。复用已确认 A–D 边界，新增行为逐条失败→最小实现→通过；没有通过读取内部表来断言业务结果，SQL 仅用于建立封闭旧版本／损坏样本。
- 同一编译产物在以下固定 Linux Node 24.22.0 镜像，以无网络、只读代码／根目录、临时可写存储执行，137 项行为测试通过：

```sh
docker run --rm --pull=never --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m --memory=512m --pids-limit=64 \
  --mount type=bind,source=/tmp/bau-spec14-worktrees/issue-19,target=/app,readonly \
  --workdir=/app \
  node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 \
  node --test dist/tests/behavior/*.test.js
```

- 本地交付引用及集成分支祖先关系检查通过。所有 SQLite 样本来自本次测试创建的受控私有临时目录，没有打开既有用户数据库。

## 后续门槛

真实费用／协议与生产存储验证仍未执行，继续按对应票的启用条件推进。#20 处理生命周期删除时，现有 durable budget.binding 尚保存脱敏后的案主／租户／会话／资源上下文，必须收敛到保留最少结算／幂等信息（例如规范绑定摘要），同时不能重置总账或释放未知槽。本票不实现角色、保留／删除或备份流程。#15 记录的 Node 安全更新通知仍为待核实更新门禁，没有因本票测试通过而标记已解决。

## #19 审查修订

维护性 P2：把内部准入的 `boolean | number` 改为共享判别联合 `admitted / rejected / wait`，等待项显式携带可选的逻辑时钟 `retryAt`；等待结算不再借用 Infinity 表示。Mock、SQLite 和队列采用相同状态，公开 `reserve` 仍返回 boolean，准入、拒绝及等待行为保持原样。

精确 Node 24.22.0 下独立类型检查、独立构建、全部 137 项既有行为测试及差异检查重新通过。再次合并集成分支 `7e45eea`，结果 already up to date。本次无行为改变，未重复 Linux 验证；上文 Linux 137 项结果对应原功能提交 `7e45eea`。
