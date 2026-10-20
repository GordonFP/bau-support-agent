# #15–#16 评审修复

对应 [#15](https://github.com/GordonFP/bau-support-agent/issues/15)、[#16](https://github.com/GordonFP/bau-support-agent/issues/16) 的增量评审；基于 `99cd1a1`，验证日期 2026-10-20。

诊断草稿现在按聚合已接受资料的版本失效：先调用 diagnose、再读取日志／代码时重新形成诊断；同一次模型调用期间没有新资料时保持原草稿及 formedAt，不受注入 UTC 时钟推进影响。公开 A／B／D 行为测试先重现原来的 0 店铺报告，再验证十店铺、9／1／0 就绪计数和两条证据。另将轮次 180 秒、模型六次、日志 500 条及模型预留金额提为具名限制，以统一助手入口和恢复轮次的期限构造。

对仅包含此修复的 Git 暂存树导出独立目录，使用 `/tmp/node-v24.22.0-darwin-arm64/bin` 中 Node.js 24.22.0 执行：

```sh
npm ci --ignore-scripts --offline
npm run typecheck
npm run build
npm test
```

离线安装、独立类型检查、构建均通过；42 个行为测试通过，包含既有 UTC 推进回归。没有新增依赖或连接真实环境。此记录不覆盖尚未完成的 #17 功能，也不声明真实 SDK／上游取消和计费已验证。
