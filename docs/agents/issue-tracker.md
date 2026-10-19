# Issue tracker: GitHub

Repository: GordonFP/bau-support-agent
Issues 和规格记录在该仓库的 GitHub Issues。
使用 gh CLI，显式指定 --repo GordonFP/bau-support-agent。
里程碑使用已有 POC、MVP；MVP 以 POC 的 Go 决策为前提。

**PRs as a request surface: no.**

## Conventions

- 发布到 tracker：创建 GitHub Issue。
- 多行正文和评论使用 --body-file。
- 读取 Issue 时包含正文、状态、标签、负责人和评论。
- 列举完整集合时分页；引用 Issue 使用带链接的标题。

## Wayfinding operations

- Map 使用 wayfinder:map 标签；决策票使用 GitHub sub-issues。
- 决策票仅使用 wayfinder:research、wayfinder:prototype、
  wayfinder:grilling 或 wayfinder:task 标签。
- 子票关系使用 GitHub sub_issues API，提交子票的数字数据库 ID。
- 阻塞关系使用 dependencies/blocked_by API，提交阻塞票的数字数据库 ID。
- 仅在原生功能不支持时使用 Part of、Blocked by 和 Map 任务列表。
- Claim：开始处理前，将决策票分配给驱动规划的人。
- Frontier：按子票顺序选择未关闭、无人认领且全部阻塞票已关闭的票。
- Resolve：评论记录结论，关闭决策票，再更新 Map 的 Decisions so far。
