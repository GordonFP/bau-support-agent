# #18 — SQLite 记录、审计故障与重启边界

对应 [#18](https://github.com/GordonFP/bau-support-agent/issues/18) 与父规格 [#14](https://github.com/GordonFP/bau-support-agent/issues/14)。基于集成分支 `abe252e`；交付前合并 `codex/poc-integration`，结果 already up to date。验证日期 2026-10-20。

## 实现与验收

| 验收 | 实际可观察结果 |
| --- | --- |
| SQLite 原生事务与单实例 | Node 内置 SQLite，无 ORM 或新增依赖。独立锁文件持有整个实例生命周期的 `BEGIN EXCLUSIVE`；第二进程拒绝启动，正常关闭或 SIGKILL 后可重新取得锁，不删除／重建锁文件。记录库使用短 `BEGIN IMMEDIATE` 事务、显式异常回滚、DELETE journal、`synchronous=EXTRA`、`secure_delete=ON`、内存临时表及关闭 trusted schema。仅允许当前用户拥有的私有目录和普通单链接文件；拒绝符号链接、未知／未来数据库格式，避免误建空账本。 |
| 可靠受理与幂等 | 可信事件摘要、初始脱敏输入、主体上下文与案件视图在同一事务提交后才开始调查。事务写故障／提交前进程死亡不留下半条受理；重启后的重复事件读取原案且重新授权，不调用日志、模型或交付。案件编号单调保存在库中。 |
| 意图与审计故障 | 外部动作之前提交稳定调用 ID 的脱敏意图；同一意图精确重放返回原凭证，改主体、案件、资源或范围复用拒绝。意图写失败不调用对应业务能力；结果／交付审计失败终止调查与证据报告，只允许一次当前授权的固定、无调查内容故障提示，且不自动重试已失败的审计路径。旧轮次迟到结果的审计失败同样阻止新轮次披露。 |
| 版本化记录 | 保存 schema 1 的输入、视图、模型输入输出、工具结果、接受的证据及报告。审计另存主体／当前请求者角色、租户与固定目的会话、案件／轮次／调用、资源、授权理由、策略／审批／快照、固定 Mock 制品／工具／净化版本、查询窗口／页限、完整性／截断／证据数、已知或未知费用来源；不复制完整响应或敏感选择器。C append 必须有相同案主及冻结权限上下文并重新授权；稳定记录 ID 不能改写不同内容，迟到视图不能覆盖终态。C read/export 分别重新授权并审计，拒绝读取也留安全记录。 |
| 未知交付 | 交付意图事务先保存原调用 ID、交付键、段号及 unknown，再发起发送。平台已发送而确认／结果审计未完成时仍是 unknown；重启从交付记录恢复 unknown，即使此前持久视图仍为 pending。没有自动重发、声称撤回或根据新 ID 对账。 |
| 重启与账本 | 重启把 investigating／awaiting_input 标为 stopped/interrupted，并在同一事务追加版本化视图与中断审计；不恢复 Agent、模型或发送。模型发起前保存累计尝试数及上限预留；未知预留、实际费用、原调用 ID 在重启后保留，重复结算不重复计费。预算及交付最小表独立于案件内容外键，未提供清空账本的案件清理路径。上下文只保存显式白名单字段，凭据、AbortSignal 和敏感原值映射不落盘。 |
| 公开边界与故障验证 | 使用既定 A–D 边界逐条失败→最小实现→通过；另以受控子进程验证真实文件锁、SIGKILL 释放与事务崩溃回滚。原生写故障注入覆盖受理、日志意图／结果、交付结果；Mock 覆盖模型／交付意图／结果及跨轮审计丢失。 |

适配器通过现有 Ports 装配到应用；业务数据库操作集中在 `adapters/records`，应用仅调用记录和审计契约。故障提示固定为 `Investigation stopped because audit storage is unavailable.`，不含案件证据或调查结果。没有增加网络服务或开放历史记录工具给模型。

## 实际验证

沿用 [#15 精确工具链与依赖核验](issue-15.md)：Node.js 24.22.0、TypeScript 7.0.2、@types/node 24.10.0；macOS arm64 和固定 Linux arm64 镜像均实测内置 SQLite 3.53.4。核对 [固定 Node SQLite API](https://raw.githubusercontent.com/nodejs/node/v24.22.0/doc/api/sqlite.md)、[SQLite 同步设置](https://www.sqlite.org/pragma.html#pragma_synchronous) 和 [文件锁机制](https://www.sqlite.org/lockingv3.html)。Node 此 API 标为 release candidate；本次以精确运行时的实际原生行为验收，不依赖最新版文档推断兼容。

```sh
export PATH=/tmp/node-v24.22.0-darwin-arm64/bin:$PATH
npm ci --ignore-scripts --offline
npm run typecheck
npm run build
npm test
git diff --check
```

- 离线安装、独立类型检查、独立构建通过；没有新增依赖。安装输出的本地审计结果为 0，不代表已完成后续公告适用性复核。
- macOS 的 101 项行为测试通过，包含此前 70 项行为及本票 31 项记录／审计／重启场景。
- 同一编译产物在以下固定 Linux 镜像以无网络、只读根目录／代码和临时可写存储执行，101 项测试通过：

```sh
docker run --rm --pull=never --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m --memory=512m --pids-limit=64 \
  --mount type=bind,source=/tmp/bau-spec14-worktrees/issue-18,target=/app,readonly \
  --workdir=/app \
  node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 \
  node --test dist/tests/behavior/*.test.js
```

- 子进程仅扫描本次临时库的具名 SQLite／journal 文件，没有发现原始合成敏感标识；扫描后竞争进程仍不能取得运行锁。该检查不证明文件系统或硬件层的取证擦除。
- 交付记录本地引用、暂存差异格式及集成分支祖先关系检查通过。

## 保留的启用条件

本票是合成闭环的真实 SQLite 持久化验证，未进行 Teams、Pi、MCP、模型或生产日志／GitLab 联调。所有数据库均来自测试创建的私有临时目录；没有打开既有用户数据库。未验证宿主加密卷／密钥、真实 PVC 锁语义、硬件断电后的刷盘保证、备份或恢复副本，备份路径没有启用。这些真实条件仍为启用门槛，不据此关闭父规格。

#19 继续完成原子案件／全局预算与并发／费率账本，包括重复 reserve 的案主／案件绑定加固；本票只持久化现有预留与结算语义。#20 继续三角色、保留／删除及备份生命周期；目前 C 只允许当前授权案主读取／导出，未开放运营审计角色。没有以本票宣称留存期限、数据库历史页或备份已清除。#15 记录的 Node 安全更新通知仍是待核实更新门禁。
