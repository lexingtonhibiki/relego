# 跨 Agent 调研委派协议 MVP 设计

**状态：** 待用户书面审阅；审阅前不实施。

## 1. 目标

建立一个本地、可追踪的调研委派边界：Codex 作为首个 Caller，把单条或批量技术调研交给 OpenCode 作为首个 Callee；主控只接收结构化摘要、可行性判断、证据、风险、未知项和详细报告索引，不接收执行端的海量中间思考。

首个可交付版本必须独立可测：离线 fake executor 覆盖完整生命周期，真实 OpenCode smoke 单独显式运行。

## 2. 范围判断

完整愿景包含四个可独立演进的子系统：

1. 任务协议、持久状态、报告与本地服务。
2. OpenCode 进程适配器。
3. Codex 调用端工作流与插件包装。
4. 未来脚本、本地服务、MCP 和其他 Agent 的通用适配器。

本设计只把前两个子系统合并为一个端到端 MVP，因为 OpenCode 适配器没有任务协议就无法单独产生用户价值。初始 Caller 直接使用 CLI，不新增 Codex 插件；通用适配器、Codex 插件和 MCP facade 各自另立后续计划。这样每个计划都能交付可运行、可测试的软件。

## 3. 方案比较与决策

### 3.1 采用：独立 loopback HTTP JSON 服务

研究服务只绑定 `127.0.0.1`，使用独立随机 bearer token，提供提交、查询、取消和健康检查。CLI 是该服务的客户端。服务拥有任务生命周期并直接监督 OpenCode 子进程。

采用该方案的原因：

- Codex 断开不会取消调研，异步句柄仍有所有者。
- 同步等待、批量并发、心跳、超时、取消和部分产出集中在同一状态机。
- 研究任务不耦合现有 Responses 路由、ChatGPT 浏览器 turn、模型目录或 MCP ABI。
- 复用仓库现有 `Bun.serve`、原子写入、用户私有目录和显式错误惯例。

### 3.2 不采用：直接扩展现有 Responses server

现有 server 的 drain、browser turn 和 Responses 生命周期属于 ChatGPT Web bridge。研究任务失败、取消或恢复不应改变 ChatGPT turn 的计数与关闭语义，因此使用独立 listener。

### 3.3 不采用：纯文件队列 + CLI

文件队列适合更小的同步实验，但长任务状态回传、并发回收、实时心跳和服务崩溃后的所有权判断会迅速复制一套隐式 RPC。独立 HTTP 服务能以较少代码明确这些边界。

### 3.4 不采用：MCP 作为唯一通信层

MCP 适合未来作为薄 facade，但现有 stdio MCP 与 ChatGPT turn capability 绑定，不能直接承担独立、持久的研究服务。MVP 不增加第二套通信载体。

## 4. 组件与职责

```text
Codex / user
    │ codex-chatgpt-web research run|submit|status|cancel
    ▼
127.0.0.1 research HTTP service
    ├─ request and model preflight
    ├─ batch coordinator and concurrency limit
    ├─ persistent task snapshots and idempotency records
    ├─ timeout, cancellation, heartbeat, recovery
    └─ OpenCode executor
           │ direct spawn, argv array, piped prompt
           ▼
       OpenCode CLI
           │ JSONL progress
           ▼
       task workspace
         report.md
         partial-report.md
```

- `research/contracts.ts`：版本化请求、报告、状态、artifact 和 executor 数据类型；使用现有 Zod 严格校验外部输入。
- `research/config.ts`：独立的 `research/config.json`，不修改现有 `AppConfig` 版本。
- `research/store.ts`：任务、批次、幂等映射、隔离 workspace 和固定报告 artifact 的原子持久化。
- `research/report.ts`：报告 JSON 校验、固定文件路径验证、部分报告生成。
- `research/opencode.ts`：能力探测、JSONL 解析、stdin/stdout/stderr 管理、进程树停止。
- `research/coordinator.ts`：唯一任务状态机、批量调度、并发、deadline、心跳、取消和重启恢复。
- `research/service.ts`：认证、HTTP 路由、同步等待和错误映射。
- `research/cli.ts`：`setup`、`serve`、`run`、`submit`、`status`、`cancel`、`doctor` 的薄客户端。
- `src/cli.ts`：只增加 `research` 命令分派和帮助文本。

## 5. 协议

### 5.1 请求

```json
{
  "protocolVersion": "research-delegation/v1",
  "tasks": [
    {
      "clientKey": "pricing-2026-09",
      "description": "调查供应商当前定价，比较两个方案，并说明证据日期、冲突和未知项。",
      "model": "provider/model-fast",
      "timeoutMs": 120000
    }
  ]
}
```

约束：

- `protocolVersion` 固定为 `research-delegation/v1`。
- 每批 1–16 个任务。
- `description` 是非空自然语言，最多 32,000 个 UTF-16 code units。
- `clientKey` 可选；格式为 `[a-z0-9][a-z0-9._-]{0,63}`。批内出现两个相同非空值时整批拒绝。
- `model` 可选；有效模型固定为 `task.model ?? user default_model`，禁止静默回退。
- `timeoutMs` 可选，范围 1,000–3,600,000 ms。
- Caller 不能指定 executable、cwd、环境变量、system prompt、绝对报告路径或状态。

### 5.2 状态

非终态：

- `queued`
- `running`
- `cancelling`

终态：

- `succeeded`
- `failed`
- `timed_out`
- `cancelled`
- `interrupted`

状态规则：

- `succeeded` 只表示执行进程正常结束、最终报告合同通过、固定详细报告存在并已发布；调研结论可以是 `infeasible`。
- `failed` 通过稳定 `error.code` 区分启动失败、非零退出、崩溃、坏报告、路径逃逸、模型不可用和资源错误。
- `timed_out` 表示 deadline 已触发且子进程树已完成清理。
- `cancelled` 表示显式取消已完成清理。
- `interrupted` 表示服务退出或重启时任务无法安全继续；不得自动重跑。
- 终态不可逆；重复取消、完成或迟到 heartbeat 不改变终态。

### 5.3 报告

```json
{
  "summary": "精炼结论",
  "feasibility": {
    "verdict": "feasible",
    "notes": "适用条件或限制"
  },
  "evidence": [
    {
      "claim": "证据支持的具体事实",
      "source": "https://vendor.example/pricing",
      "observedAt": "2026-09-24"
    }
  ],
  "risks": ["风险"],
  "unknowns": ["尚未核实事项"],
  "reportPath": "report.md"
}
```

约束：

- `feasibility.verdict` 为 `feasible | partially_feasible | infeasible | unknown`。
- `evidence` 可为空，但此时 `unknowns` 必须解释证据缺口。
- `reportPath` 必须严格等于 `report.md`。
- 最终 assistant text 的最后一个非空 completed text part 必须是一个且仅一个 JSON 文档。
- `report.md` 必须是 workspace 内的非空普通文件；绝对路径、`..`、符号链接和根外真实路径均拒绝。
- 详细报告索引由服务生成，包含 gateway 控制的绝对路径、大小、SHA-256 和 `complete` 标志；模型不能提供可信路径或状态。

### 5.4 Artifact

MVP 只发布两个固定 artifact：

- `detailed_report`：成功时从 workspace 的 `report.md` 复制到 artifact 目录。
- `partial_report`：失败、超时、取消或中断时，从 `partial-report.md` 或最后的可见 text 生成；永远 `complete: false`。

不递归索引任意文件，不执行模型提供的路径，不自动删除失败证据。

## 6. 持久化布局

```text
<application-home>/research/
  config.json
  batches/<batch-id>.json
  idempotency/<sha256>.json
  jobs/<task-id>/
    state.json
    workspace/
      report.md
      partial-report.md
    artifacts/
      detailed-report.md
      partial-report.md
```

- `task-id` 和 `batch-id` 只由服务生成，物理路径不使用用户标题、描述或模型输出。
- 状态文件使用现有 `atomicWriteFile`，目录权限目标为 `0700`，文件为 `0600`。
- 相同 `Idempotency-Key` 和相同规范化请求返回原批次；同一 key 的不同请求返回 HTTP 409。
- 客户端未提供 key 时允许重复提交，但响应必须明确这是非幂等调用；CLI 默认生成 UUID key。

## 7. OpenCode 执行合同

经官方资料和固定 tag 核验的 MVP 命令能力：

- `opencode run --format json --model provider/model --dir PATH --title ID --auto`
- 无位置参数且 stdin 为非 TTY 时，OpenCode 把 stdin 作为 prompt；服务写入后必须关闭 stdin。
- `--format json` 输出 JSONL 事件，不是单个最终 JSON。
- `text` 事件的 `part.type` 为 `text`，最终文本位于 `part.text`。
- `error` 事件表示执行端错误；进程退出码仍需独立检查。
- `--auto` 只批准未被显式 deny 的权限。

每个任务通过 `OPENCODE_CONFIG_CONTENT` 注入最小权限合同：

- deny `bash`、`task`、`skill`、`lsp`、`question`、`plan_enter`、`plan_exit`、`external_directory`。
- allow 当前 workspace 的 `read`、`edit`、`glob`、`grep`、`webfetch`、`websearch`。
- deny `.env` 与 `.env.*` 读取。
- 允许的 edit 范围来自 `--dir` 指向的独立 workspace；OpenCode 权限是应用层控制，不替代 OS 沙箱，文档必须明确这一限制。

服务分别持续排空 stdout 和 stderr，限制原始输出大小，不把 prompt、环境变量或凭据写入日志。OpenCode JSON 事件不是稳定跨版本协议，因此启动和每次执行前都通过 `--version`、`run --help`、`models` 做能力探测；缺少所需 flag 或模型时显式失败。

## 8. 生命周期与恢复

- Coordinator 在启动时重新扫描持久任务。
- `queued` 任务重新入队。
- `running` 或 `cancelling` 任务在重启后变为 `interrupted`，保留已有 artifact，不自动启动第二次执行。
- 终态任务原样恢复。
- 同一任务最多一个活动 executor；取消和 timeout 先持久化停止意图，再终止进程树。
- heartbeat 只用于观测，绝不延长绝对 deadline。
- 批量任务先整批预检，再持久化全部任务；一个任务的执行失败不影响其他任务。
- 服务优雅关闭会停止活动 executor 并把任务收敛到 `interrupted`；非正常崩溃后的孤儿进程不会被仅凭裸 PID 自动杀掉，恢复状态明确告诉用户需要人工检查。

## 9. 用户配置

`research/config.json`：

```json
{
  "version": 1,
  "host": "127.0.0.1",
  "port": 17842,
  "controlToken": "至少 40 个 URL-safe 字符",
  "workspaceRoot": "<application-home>/research/jobs",
  "opencodeCommand": ["<absolute-opencode-executable>"],
  "defaultModel": "provider/model",
  "defaultTimeoutMs": 120000,
  "maxConcurrency": 2,
  "heartbeatMs": 15000
}
```

- 不修改现有 `AppConfig`、Responses 端口、模型目录或服务生命周期。
- setup 必须验证 OpenCode executable、`run --help` 所需 flags 和默认模型。
- 模型和 executable 不进入任务请求；用户默认和任务覆盖是唯一选择来源。

## 10. HTTP API

所有 `/v1/research/*` 路由要求 `Authorization: Bearer <controlToken>`。

- `GET /healthz`：服务健康、版本、活动任务数；不暴露 token、prompt 或环境。
- `POST /v1/research/batches?wait=false`：提交 1–16 个任务；异步返回 202。
- `POST /v1/research/batches?wait=true`：提交并等待整批进入终态；终态返回 200。
- `GET /v1/research/tasks/:id`：读取状态、heartbeat、报告、artifact 和错误。
- `POST /v1/research/tasks/:id/cancel`：幂等取消。

HTTP 客户端断连不等于任务取消。请求无效或任一显式/默认模型不在已探测目录时返回 400，幂等冲突返回 409，未授权返回 401；OpenCode 启动后的任务执行失败仍以合法批次状态返回 200/202。

## 11. 测试与验收

离线测试必须使用真实临时目录和真实子进程边界，但不得调用真实模型：

1. 请求合同、模型优先级、重复 client key 和无效模型均不启动错误任务。
2. 相同幂等 key + 相同请求只执行一次；不同请求返回冲突。
3. 批量一项成功、一项失败时两项都有独立终态，输入顺序保持。
4. OpenCode JSONL 文本聚合、error、非零退出、stdin 关闭和 argv/env 均有断言。
5. 退出 0 但报告缺失、坏 JSON、字段错误或路径逃逸时任务为 `failed`。
6. timeout 或 cancel 保留 `partial_report`，不产生 `detailed_report`，且进程树停止。
7. 重启恢复 queued 任务并把 running 任务标为 interrupted，不产生重复执行。
8. 未授权、400、404、409、断连后继续运行和批量 wait 行为通过真实 loopback HTTP 测试。
9. CLI 的 stdout 始终只有一个 JSON 文档，诊断只写 stderr，退出码准确。
10. 显式 live smoke 使用真实 OpenCode 和用户选择模型，只验证协议链路，不作为默认 CI。

## 12. 明确延期

- GenericAgent、OpenClaw、WorkBuddy、Trae、Claude Code、Antigravity、ZCode adapter。
- Python 脚本和本地服务 adapter。
- MCP facade。
- Codex 插件和自动触发策略。
- 分布式队列、跨机器 lease、HA、自动接管任意孤儿进程。
- 自动 300k token 阈值压缩；MVP 依赖 OpenCode 自身上下文管理并把长内容写入固定报告文件。
- 自动重试、模型成本路由、凭据代理、远程 worker 和报告签名。

## 13. 官方依据

- OpenCode CLI：https://opencode.ai/docs/cli
- OpenCode permissions：https://opencode.ai/docs/permissions
- OpenCode 固定 tag 测试：https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/test/cli/run/run-process.test.ts
- Codex non-interactive mode：https://developers.openai.com/codex/noninteractive
- Codex CLI reference：https://developers.openai.com/codex/cli/reference
