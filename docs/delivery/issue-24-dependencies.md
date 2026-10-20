# #24 依赖检查点

基线 `54ac570`；仅冻结 Teams apps／api／common 2.1.1、Express 开发类型 5.0.6 及可复现依赖预检。全部既有锁条目不变，未增加应用运行路径。制品、传递依赖、许可证／公告与类型局限见 [协议依赖记录](protocol-dependencies.md#24-teams-依赖检查点)。

实际验证：

- 四个直接制品 registry／lock／独立下载 SHA-512 一致；全部 46 个新增锁制品独立下载 integrity 一致，新增项无安装脚本。npm audit：0。
- Node 24.22.0、TypeScript 7.0.2：项目类型检查／构建通过；Teams 独立完整声明正例通过、负例 TS2769；Pi 严格消费端正／负例通过。
- 实际当前 Teams SDK：签名服务路由、plain client 的 OAuth 404、成功／429／消费请求后 reset 各一物理 POST，macOS 和受限 Linux arm64 通过。仅合成服务，无真实租户。
- 既有 262 项行为测试：macOS 262／262，受限 Linux 262／262。差异、脚本语法和文档本地链接检查通过。

```sh
export PATH=/tmp/node-v24.22.0-darwin-arm64/bin:$PATH
npm run typecheck
npm run build
node scripts/check-pi-types.mjs
node scripts/check-teams-types.mjs
node scripts/check-teams-interop.mjs
node --test dist/tests/behavior/*.test.js
npm audit --json --registry=https://registry.npmjs.org

docker run --rm --pull=never --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m --memory=512m --pids-limit=64 \
  --mount type=bind,source=/tmp/bau-spec14-worktrees/issue-24,target=/app,readonly \
  --workdir=/app \
  node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 \
  node scripts/check-teams-interop.mjs
# 同一容器限制下运行完整行为集：
# node --test --test-concurrency=2 dist/tests/behavior/*.test.js
```

初次缺失 Express 类型的四项 TS7016 未记为通过；补齐后重新执行。项目既有 Pi 第三方完整声明检查失败／有限 skipLibCheck 决策未被更改或改称通过。

后续仍须实现并验证 #24 的全部通信业务验收，包括 A→Pi→D、字节上限、服务／用户双重认证、当前披露、状态／补问、子段独立审计及持久 unknown／无重放；本检查点不代表 #24 完成。真实租户与 G3、Node 更新通知、完整分发 notices／签名／镜像／部署门禁未完成，不关闭父规格 #14。未推送或操作 tracker。
