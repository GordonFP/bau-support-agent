# #24 Teams 本地协议闭环

基于集成提交 `3f67f36`，复用已确认的 A–D 边界。精确 Teams 依赖与原生消费端检查见 [依赖检查点](issue-24-dependencies.md)；本次显式直接依赖已有的 OpenTelemetry API 1.9.1，用于启动前安装 no-op provider，没有升级制品或传递依赖。

## 实现与授权

- 自有 Node HTTP Adapter 在解析前限制原始消息 64 KiB、32 个连接／在途请求及不随进度重置的 5 秒读取窗口；拒绝压缩、无效 UTF-8、未知活动字段和非私聊。只有实际 SDK 验证服务签名后才进入业务处理；再由实际 JwtValidator 校验独立用户证明，核对 tid／oid／scope／受众／有效期与宿主固定私聊注册表。
- 服务地址和认证端点只允许显式 `local_protocol` loopback 配置。消息正文、显示名、email、mention 或会话 ID 不授予权限；不使用 `ctx.token`、`ctx.send`、stream、Graph、roster、附件或 progress。普通内存 Mock 仍无网络。
- 接受、补问、查询、取消复用 A；ACK 与调查异步。补问回执按固定目的会话散列，并绑定原案件／问题／主体；不能借另一个会话的同名平台回执恢复案件。持久重复事件只返回受控状态，不恢复调查或重发。
- 有限状态／问题和已校验报告通过应用 D 净化、当前授权和审计。最多 24 KiB 的完整正文按更小平台配置以 UTF-8／grapheme 安全分段；每个原交付键＋子序号在物理写入前已有持久 intent。SDK 获取 token 后的最终原生请求拦截器重新证明当前用户，再执行宿主 `beforeWrite`，校验实际序列化内容／大小，才允许唯一物理 POST。每段保存散列确认回执；丢失或非法确认保持 unknown，停止后续段且无整包重试。
- A.get 的宿主回调位于审计之后、最终资源授权之前；持久 C.read 使用同一门。所有含案件元数据的 HTTP ACK 在编码前同步复查证明有效期与信号。最终拒绝也审计；身份拒绝审计故障锁闭宿主。业务审计故障只允许既有固定、无业务数据的故障通知，不重试损坏审计链。
- 显式丢弃 logger、no-op tracer／meter 和 ambient preload／OTEL 配置拒绝在 SDK 流量之前生效。宿主关闭复用应用原始 phase 清理，先锁闭 admission，再等待原始 HTTP／认证／发送／Agent／审计工作；全局共用 5 秒响应边界。未结束或失败的清理保持 unknown／C partial。单个映射清理失败仍中止其他案件；正常关闭不触发删除、不清空持久幂等或预算。

## 实际验证

固定 Node 24.22.0、TypeScript 7.0.2：类型检查、构建、Pi 严格消费端正／负例、Teams 独立完整声明正／负例和原生互操作预检通过。项目既有第三方 `skipLibCheck:true` 决策及 Pi 全声明失败记录保持原样，不能改称全声明检查通过。

- macOS 与受限 Linux arm64 完整行为集各 **331／331** 通过，包含集成 #25／#26 原有 298 项。实际签名 HTTP → A → Pi 1.3.0 → Responses／两个独立 MCP 服务 → C／Teams Connector 报告往返通过；ACK 在调查完成前返回。
- 拒绝矩阵包含缺失／伪造／过期服务签名、伪造／撤权／过期／错误用户／租户／scope、身份冲突及群组；零日志／模型／交付调用。另验证审计期间撤权／过期、持久重启查询、token 获取期间撤权、每段授权撤回、非法确认／429／已消费请求 reset、可信补问／重复回复、取消、撤权后的宿主关闭、迟到 admission 和原始认证未结束时的删除 partial。
- SQLite 真实临时存储验证原交付 unknown、重启后的多次重复事件、无恢复／重放及子段审计。原有崩溃测试区分本票新增的已确认状态回执和未知报告回执，原始报告 unknown 断言保留。
- 四项受影响 Postman CLI 本地协议检查通过：Teams Connector、Kibana 子集与两项 Responses；实际 SDK 流量符合仓内受审闭合契约，无云 workspace／登录或真实凭据。

```sh
export PATH=/tmp/node-v24.22.0-darwin-arm64/bin:$PATH
npm run typecheck
npm run build
node scripts/check-pi-types.mjs
node scripts/check-teams-types.mjs
node scripts/check-teams-interop.mjs
node --test --test-concurrency=2 dist/tests/behavior/*.test.js
POSTMAN_CLI=/path/to/postman node --test --test-concurrency=1 \
  dist/tests/contracts/teams-postman.test.js \
  dist/tests/contracts/model-postman.test.js \
  dist/tests/contracts/kibana-postman.test.js

docker run --rm --pull=never --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m --memory=512m --pids-limit=64 \
  --mount type=bind,source="$PWD",target=/app,readonly --workdir=/app \
  node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 \
  node --test --test-concurrency=2 dist/tests/behavior/*.test.js
```

受限 Linux 首轮为 **330／331**：既有 MCP 250ms deadline 测试预期 timeout，实际 unavailable；该失败不记通过。未修改时限、资源配置或断言，随后精确隔离复测及完整 **331／331** 复测通过。差异、协议 mock 脚本语法及本地文档链接检查通过。

真实租户服务／用户 SSO、撤权传播、历史受众可见性、实际平台上限与部署身份／网络／卷／加密条件属于未执行 G3。当前会话注册表和本地 JWT 只是合成协议证明，不能据此打开真实路由或关闭父规格 #14。Node 更新门禁、最终 notices／签名／镜像分发证明仍待完成。未推送或操作 tracker。
