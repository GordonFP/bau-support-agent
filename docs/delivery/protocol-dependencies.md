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

共享依赖提交当时的锁文件含 199 个条目（包括原有工具链和其他平台可选编译器），全部绑定公开 registry URL 与 integrity；macOS arm64 实际安装 180 个。该快照的许可证元数据为 MIT 121、Apache-2.0 55、BSD-3-Clause 13、ISC 7、Unlicense／BSD-2-Clause／0BSD 各 1。精确传递版本及各条目的 SPDX／integrity 以 `package-lock.json` 为准，#23 的新增项见下文。Pi-ai 传递引入 OpenAI 7.19.0、其他供应商 SDK、telemetry 和 typebox 1.3.27；#21 只调用固定 Responses codec，不启用其他供应商或遥测出口。

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

## #23 原生 Pi 会话增量

2026-10-21，在 `497d42a` 基线上精确增加 `@earendil-works/pi-coding-agent@1.3.0`，并将已有 `typebox@1.3.27` 显式列为直接依赖；未改变既有 Pi-ai／MCP／Zod／工具链版本。安装继续 `--ignore-scripts`。coding-agent 与 agent-core 1.3.0 为 MIT、ESM、Node >=22.19.0；TypeBox 为 MIT，随包 LICENSE 已核对。新依赖中没有安装脚本，未编译原生扩展。

```text
coding-agent1.3.0: sha512-V/WoCjA2hQSe3QLWIUB24cTRdtEdeLiIzkDqU5RMXV6VWuD+KGZnzVBMhglwdnQTySkehZsjt8a3g6Jd2g4nnw==
typebox1.3.27: sha512-zu+jc1pcy4UiNThxikUr36f0Rybk9PEeCg/NE6adeWr/SKsdNO4EzZHYRDlv2YCVAfj3Odq3dESSo/jNyoBXzA==
```

两个直接制品的独立下载 SHA-512 与 registry 元数据、lock 一致；另逐一重新下载全部 27 个新增锁条目并核对 integrity，全通过。当前锁图共 226 项，macOS 实际安装 207 项。新增许可证元数据 MIT 16、Apache-2.0 2、BSD-3-Clause 2、ISC 5、BlueOak-1.0.0 2；后者是 lru-cache／minimatch，随包有 LICENSE.md。新增 Pi agent-core／codemode／coding-agent／tui 四包没有独立许可证文件，须与固定发布源码的根 MIT 及最终分发通知一起处理。pi-mcp 随包有 LICENSES 目录，Photon 0.3.4 的 Apache 文本和 quickjs-wasi 3.6.2 的 MIT 文本随包存在；未声称完整分发义务已核准。#28 必须重新盘点最终制品，包括既有两项通知缺口和本次增量。

实际公开 API 为进程内 `createAgentSession`、`ModelRuntime.create/registerNativeProvider`、内存 SessionManager／SettingsManager、显式 ResourceLoader、customTools、`prompt/waitForIdle/abort/dispose`，以及 pi-ai 的 `createProvider/createAssistantMessageEventStream`。安装包 sdk.js.map 的完整 sourcesContent 与[固定 SDK 源码](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/sdk.ts)逐字节一致。运行证据见 [#23 交付](issue-23.md)，不以 API 名称或包导入代替实际工具闭环。

本次 npm audit 为 0。重新读取 [Pi 官方安全公告](https://github.com/earendil-works/pi/security/advisories)共四项，声明的受影响版本均早于本次 1.3.0；不据此宣称全部默认能力、任意 transport 或未来版本安全。没有核验发布签名／attestation 信任链。

实际引入 coding-agent 根类型闭包后，TypeScript 7.0.2 strict NodeNext 全声明检查确实失败：42 个 TS1543，全部在 pi-ai providers 的 JSON 模型声明缺少 `type:"json"` 属性；没有项目源错误。#21 的较窄 import 闭包此前通过完整声明检查，这两项记录分别成立。现仅跳过第三方声明体检查（`skipLibCheck:true`），保留 strict／NodeNext／noEmitOnError 和全部项目源检查，不改包、不加 any shim／抑制注释。[消费端验证脚本](../../scripts/check-pi-types.mjs)实际证明合法 SDK 调用通过，错误 tools 参数仍报唯一 TS2322；全声明检查仍记为失败，不能改称通过。

受限 Linux arm64 使用同一只读安装实际运行 coding-agent 根导入、原生会话／工具／MCP／模型闭环。Node 公共模块加载 hook 的独立清单观察到 Pi agent-core／ai／codemode／coding-agent／mcp／tui、TypeBox、OpenAI 等 JS 闭包；没有加载 Photon／quickjs-wasi 模块或 koffi／sandbox 平台制品。Pi MCP／codemode 模块存在不表示能力已启用。当前文本排障路径的实际平台兼容已验证；图像、WASM、TUI／CLI、沙箱及其他平台能力未执行，不能沿用该结果。没有为测试启用默认工具、安装脚本、额外网络或更宽容器权限。
