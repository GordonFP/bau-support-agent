# #15 — Simulator 最小离线闭环

对应 [#15](https://github.com/GordonFP/bau-support-agent/issues/15) 与父规格 [#14](https://github.com/GordonFP/bau-support-agent/issues/14)。验证日期：2026-10-20。

## 交付范围

通过既定 A（`accept/get`）、B（日志、代码、Agent、模型）、C（审计／预算 Port）与 D（固定会话报告交付）验证唯一定位的合成 Simulator 请求。`accept` 返回受理视图，调查异步运行；领域保留本次提交日期和店铺集合，区分数据、执行、成功与估额结果，拒绝不匹配目标和未经接纳的报告引用。

首次路径即检查主体、资源、允许工具、净化、审计意图、模型费用预留及当前披露权限。必要控制缺失时拒绝受理。所有外部能力均为不创建网络连接的 Mock；`OfflineScope.mode` 只接受 `mock`。合成适配器显式提供固定查询时间窗与快照，应用不从提问日期推算业务提交日。未接入实际 Teams、Pi、MCP、模型网关或业务资源。

最小模型使用一个 `TroubleshootingCase`，保留证据接纳及终态不变量；平台类型止于适配器，领域不读取时钟、网络或存储。不引入额外框架。DDD 自检沿用规格的 9/10：领域事件项不采用，当前没有独立跨聚合业务通信需求。

模型 Mock 仅回传宿主生成的确定性证据报告候选；宿主保留实际草稿并严格校验。此实现不证明真实模型的解释或因果判断能力。补问、取消、幂等和多轮计时由后续票承接；未预建其空实现。

## 工具链与制品核验

| 制品 | 实际验证 |
| --- | --- |
| Node.js 24.22.0 | 官方 Darwin arm64 tar.gz 下载、解包及运行；SHA256 `6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5` 与官方 SHASUMS256.txt 相同。实际 ABI：modules 137、N-API 10；发行包 LICENSE 包含 Node MIT 及其第三方许可。 |
| TypeScript 7.0.2 | 精确安装公共 npm 发布包，原生 Darwin arm64 7.0.2 编译器实际输出版本并完成 NodeNext／strict 编译；Apache-2.0。未依赖其不稳定的编程 API。 |
| @types/node 24.10.0 | 精确安装、检查实际 MIT LICENSE；不跳过声明检查，`node:test`／`node:assert/strict` 与所选编译器通过类型检查和运行验证。 |
| 传递依赖 | lockfile 固定 `undici-types` 7.16.0（MIT）及 TypeScript 各平台 7.0.2 可选制品；本机实际安装 `@typescript/typescript-darwin-arm64` 7.0.2（Apache-2.0）。其他平台制品只锁定，未运行。TypeScript 包内另附 vscode-jsonrpc 许可。 |
| 完整性与公告 | lockfile 记录公共 registry URL／SHA512；安装禁用生命周期脚本。`npm audit signatures` 验证四个实际安装包的 registry 签名及一个 attestation；`npm audit --json` 为 0 个已知漏洞。检查 TypeScript／DefinitelyTyped 官方公告页，未发现已发布公告。以上不等于没有未知漏洞。 |

官方资料：[Node 24.22.0 发布](https://nodejs.org/en/blog/release/v24.22.0)、[官方校验和](https://nodejs.org/dist/v24.22.0/SHASUMS256.txt)、[TypeScript 7 发布说明](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)、[7.0.2 发布](https://github.com/microsoft/TypeScript/releases/tag/v7.0.2)、[TypeScript 安全公告](https://github.com/microsoft/TypeScript/security/advisories)、[DefinitelyTyped 安全公告](https://github.com/DefinitelyTyped/DefinitelyTyped/security/advisories)。

**待更新的安全门槛**：[Node 官方 2026-10-14 预告](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)称 24.x 将于 10 月 21 日发布最高 HIGH 的安全修补；截至本次验证，详细漏洞及适用路径尚未公开。本次仅离线合成行为通过，实际部署前须回查公告、核验影响并按版本变更约定重跑。没有将待核验影响记作安全通过，也没有擅自替换固定基线。

## 执行与结果

本机固定运行时解包位置为 `/tmp/node-v24.22.0-darwin-arm64`。后续工作可使用下面的命令；换平台时须另行验证对应 Node／TypeScript 制品。

```sh
export PATH=/tmp/node-v24.22.0-darwin-arm64/bin:$PATH
npm ci --ignore-scripts --offline
npm run typecheck
npm run build
npm test
npm audit --json
npm audit signatures
git diff --check
```

- 20 个行为测试通过：十店 D／D-1、跨日、数据齐备但执行／成功／结果未知、证据不足、未知覆盖、partial、主体／资源／工具／披露拒绝、案外／不存在引用、同案脱敏、真实审计引用、预算 Port、缺失控制、审计意图失败、模型期间 UTC 推进及异步净化失败安全结束。
- 已观察首条用例的缺模块红灯，并在目标不符、输出不安全、审计引用、模型期间时间推进、输入不安全和异步启动故障的行为切片中观察红灯，再以最小实现转绿；其余既有保证通过同一公开边界回归验证。
- 独立类型检查、构建、registry audit／签名核验及差异格式检查通过。ESM、NodeNext、strict、显式 rootDir／outDir，先编译 JavaScript 再运行 `node:test`；脚本拒绝不同 Node 补丁版本。

未执行／未证明：实际 SDK 与服务制品协议、Linux／容器及 digest、真实用户／租户身份链、生产只读权限／网络／日志字段、真实收费／存储／删除、真实历史样本质量。审计和预算当前是内存 Mock Port；其持久、并发及故障保证由后续票验证。本票的离线结果不作为关闭真实联调票或父规格的依据。
