# #21／#22 固定协议依赖

2026-10-20，基于集成提交 `918c38c`，仅安装公开 npm 制品，不启动真实服务。两票共享本次依赖提交；#21 负责锁文件，#22 不独立修改版本。

| 依赖 | 精确版本 | 许可证／运行要求 | 已验证公开 API |
| --- | --- | --- | --- |
| `@earendil-works/pi-ai` | 1.3.0 | MIT；Node >=22.19.0 | `api/openai-responses` 的 `streamSimple` 与注入 fetch、maxRetries、maxTokens；SDK 类型只在 Adapter 使用 |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT；Node >=18 | 独立 `Client`、`StdioClientTransport` 的 maxBufferSize |
| `zod` | 4.6.7 | MIT；沿用 SDK 已锁定制品 | `z.strictObject` 拒绝未知字段，用于 #22 闭合结果 DTO |

来源：[Pi 固定 Responses 实现](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/api/openai-responses.ts)、[Pi 制品元数据](https://registry.npmjs.org/@earendil-works%2fpi-ai/1.3.0)、[MCP 制品元数据](https://registry.npmjs.org/@modelcontextprotocol%2fsdk/1.32.1)。未增加 coding-agent、Teams 或版本升级。

## 制品、传递依赖与许可证

实际安装使用 Node 24.22.0、`npm install --save-exact --ignore-scripts --no-fund --no-audit --registry=https://registry.npmjs.org`。两个直接制品单独重新下载并以 SHA-512 核对 registry 与本仓 lock，一致：

```text
pi-ai1.3.0: sha512-KaBI8x7q7sPoFUXICNGD9efHzDG+oRNwVvkA9jdIsSQWH1RjFssOlEGsbLtewUPPgCrvmz0l2KTgSLXTyj3acw==
MCP1.32.1: sha512-2DdE+SJDtzLEEWzY1ZjY7Q+VcPhcV1KisD3zI4u0XZyktsjHum1mwbMI+JaulUBi2OZk+KJAi2uPXzxichPkdw==
```

锁文件含 199 个条目（包括原有工具链和其他平台可选编译器），全部绑定公开 registry URL 与 integrity；macOS arm64 实际安装 180 个。许可证元数据为 MIT 121、Apache-2.0 55、BSD-3-Clause 13、ISC 7、Unlicense／BSD-2-Clause／0BSD 各 1。精确传递版本及各条目的 SPDX／integrity 以 `package-lock.json` 为准。Pi-ai 传递引入 OpenAI 7.19.0、其他供应商 SDK、telemetry 和 typebox 1.3.27；本票只调用固定 Responses codec，不启用其他供应商或遥测出口。

已检查 install-script 标记：`@google/genai` 的安装前脚本为 no-op，protobufjs 的安装后脚本检查版本方案并可能输出警告；本次全部跳过。没有为这些协议包编译原生扩展。后续逐文件核对纠正两项初次扫描遗漏：bignumber.js 9.3.1 随包有完整 `LICENCE.md`，data-uri-to-buffer 4.0.1 的 README 内含完整 MIT 文本。另七包没有独立 license／notice 文件：AWS credential-provider-http／credential-provider-login／nested-clients、pi-ai／pi-telemetry、proxy-agent-negotiate、standardwebhooks。其中前五包已有精确版本对应的官方源许可证；proxy-agent-negotiate 的完整授权文本仍缺，standardwebhooks 的包元数据 MIT 与对应根许可证 Apache-2.0 的适用性仍待确认。不能把 SPDX 元数据或已找到文本视为全部分发通知证明；后续 #28 须核对最终镜像、汇总适用通知并解决两项缺口。本次没有声称完成制品签名／attestation 信任链核验或分发许可核准。

## 安全及兼容性实际结果

- 对当前完整锁图执行 npm audit：0 vulnerabilities。这是当日 registry 公告结果，不是应用安全审查或未来安全保证。
- [Pi 公告](https://github.com/earendil-works/pi/security/advisories) 4 项的受影响对象是旧 coding-agent（最晚 <0.79.0）；[MCP 公告](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories) 10 项中，SDK 受影响范围均止于本版本之前，部分只影响其他 2.x 包。没有据此声称全部真实 transport／OAuth 路径安全。
- Node 24.22.0 macOS arm64 原生模块导入成功；Responses／MCP API 消费端在 TypeScript 7.0.2、strict、NodeNext、完整声明检查下通过。首次独立探测遗漏 TS7 要求的 `--ignoreConfig`，返回 TS5112，补上后通过；故障不记为通过。
- 当前选用 import 闭包未重现既有研究中 coding-agent 的 42 个 TS1543 上游 JSON 声明错误，因此保留项目 `skipLibCheck:false`。数字选项传入字符串的负例按预期失败 TS2322，未增加 any shim 或关闭项目检查。未来 coding-agent 接入须另验其声明闭包。
- 依赖安装后独立 `npm run typecheck`、`npm run build`、macOS 全部 173 项既有行为测试通过。此依赖提交没有应用 wire／MCP 业务实现；Linux 协议运行、完整生成／取消／字节行为由对应票后续验证，不在此记通过。

#15 的 Node 安全更新通知仍为待核实更新门禁。所有模型／生产源／Teams 真实路径继续关闭；上述包核验不证明真实部署、模型别名、费用或数据政策。

## #22 闭合 schema 的直接依赖

将 SDK 已有 transitive／peer `zod@4.6.7` 显式列为直接依赖，不改变其制品或其他锁定版本。重新下载官方制品验证 registry／lock SHA-512 一致；MIT 与随包 LICENSE 已核对。实际 strictObject 接受已知字段、拒绝额外字段，npm audit 仍为 0。这样避开本票不使用的 SDK Ajv provider 声明 TS2709，不放宽项目类型检查。该直接依赖调整后，类型检查、构建及原有 173 项测试通过。
