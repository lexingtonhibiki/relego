# relego

本地调研委派网关：Agent（Codex、Claude Code、ZCode 等）把有边界的调研任务提交给低成本的 OpenCode 执行器，收回结构化结论 —— 摘要、可行性判定、证据、风险、未知项 —— 以及详细报告工件。

以仅回环监听的 HTTP 服务运行，支持批量提交、幂等重放、绝对 deadline、持久化生命周期状态与崩溃安全恢复。安装、生命周期、安全边界与恢复见 [docs/research-delegation.md](docs/research-delegation.md)，绑定设计 spec 见 [docs/research-delegation-design.md](docs/research-delegation-design.md)。

## 开发

```bash
bun install
bun run test        # 全量测试
bun run typecheck   # tsc --noEmit
```

需要 [Bun](https://bun.sh) 1.4+ 与本地 OpenCode 可执行文件。除 zod 外无其他运行时依赖。
