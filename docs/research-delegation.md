# Codex → OpenCode research delegation

This experimental local service delegates source-backed research from Codex to OpenCode without changing the Responses, model-catalog, browser, or MCP contracts.

## Scope

The MVP supports one OpenCode executor, one local loopback listener, 1–16 tasks per batch, synchronous and asynchronous submission, cancellation, heartbeats, fixed reports, partial output, and restart recovery. Generic adapters, MCP, Codex plugins, distributed workers, and automatic retries are separate projects.

## Install and configure

OpenCode must already be installed and authenticated for the selected model.

```bash
codex-chatgpt-web research setup \
  --model provider/model-fast \
  --opencode /absolute/path/to/opencode \
  --port 17842 \
  --workspace ~/.codex-chatgpt-web/research/jobs
```

Setup stores `research/config.json` with a random control token. It verifies `opencode --version`, `opencode run --help`, and `opencode models`. A missing flag or model fails setup; the gateway never falls back to another model.

## Run the service

```bash
codex-chatgpt-web research serve
```

The service binds only `127.0.0.1`. All `/v1/research/*` routes require the stored bearer token. The service must remain running for asynchronous submission and status queries.

## Submit work

Create `request.json`:

```json
{
  "protocolVersion": "research-delegation/v1",
  "tasks": [
    {
      "clientKey": "pricing-2026-09",
      "description": "Research current vendor pricing and cite dated sources.",
      "model": "provider/model-fast",
      "timeoutMs": 120000
    }
  ]
}
```

Synchronous:

```bash
codex-chatgpt-web research run request.json
```

Asynchronous:

```bash
codex-chatgpt-web research submit request.json
codex-chatgpt-web research status rt_0123456789abcdef0123456789abcdef
codex-chatgpt-web research cancel rt_0123456789abcdef0123456789abcdef
codex-chatgpt-web research doctor
```

CLI commands emit one JSON document on stdout. Diagnostics use stderr. `run` exits 0 only when every task is `succeeded`; a valid task failure is reported in the JSON and exits 1.

## Status and partial output

Non-terminal states are `queued`, `running`, and `cancelling`. Terminal states are `succeeded`, `failed`, `timed_out`, `cancelled`, and `interrupted`.

`succeeded` requires a normal process exit, a valid final report contract, a non-empty `report.md`, and a published `detailed_report`. A research conclusion of `infeasible` can still be a successful task.

Timeout, cancellation, executor failure, crash, and service interruption preserve `partial_report` with `complete: false`. They never publish a `detailed_report` or claim that partial text is a completed report.

## Idempotency and concurrency

HTTP callers may send `Idempotency-Key`. The same key and canonical request return the original batch; the same key with a different request returns HTTP 409. The CLI generates a UUID key for each invocation. A batch is fully validated before any executor starts. `maxConcurrency` defaults to 2 and is configurable from 1 through 8.

## Storage and recovery

```text
<application-home>/research/jobs/<task-id>/workspace/report.md
<application-home>/research/jobs/<task-id>/workspace/partial-report.md
<application-home>/research/jobs/<task-id>/artifacts/detailed-report.md
<application-home>/research/jobs/<task-id>/artifacts/partial-report.md
```

On restart, queued tasks resume. Running or cancelling tasks become `interrupted`; they are not automatically rerun. The gateway reconciles task records and removes any unpublished detailed artifact before recovery. Inspect the workspace and use a new task for a new attempt. The supervisor tears down its tracked process tree, but it does not kill an unverified bare PID.

## Security boundary

The task description and retrieved pages are untrusted data. The gateway injects a fixed report contract and an OpenCode permission configuration that denies shell commands, subagents, skills, LSP, interactive questions, and external directories. It allows read/edit/glob/grep and web research inside the task workspace.

OpenCode permission configuration is 应用层权限控制，不是操作系统沙箱. The store repairs POSIX directory modes and applies a private Windows ACL to its managed directories during initialization. Use a trusted local account, do not expose the listener beyond loopback, and do not place secrets in task descriptions. The gateway never logs prompt text, environment variables, bearer headers, or provider credentials.

## HTTP API

- `GET /healthz`
- `POST /v1/research/batches?wait=false`
- `POST /v1/research/batches?wait=true`
- `GET /v1/research/tasks/:id`
- `POST /v1/research/tasks/:id/cancel`

Client disconnect does not cancel accepted work. Cancellation is explicit and idempotent.

## Live smoke

The deterministic test suite uses a fake OpenCode executable. The real-model smoke is opt-in:

```bash
bun run smoke:research:opencode
```

It uses an isolated temporary workspace and store, an inline-fact task to avoid depending on a website, then validates the real model selection, report schema, artifact path, and service cleanup without inspecting or modifying the production research store. It does not prove factual accuracy.
