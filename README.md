# research-gateway

A local research delegation gateway: agents (Codex, Claude Code, ZCode, ...) submit bounded research tasks to a low-cost OpenCode executor and receive structured findings — summary, feasibility verdict, evidence, risks, unknowns — plus a detailed report artifact.

Runs as a loopback-only HTTP service with batch submission, idempotency, absolute deadlines, persisted lifecycle state, and crash-safe recovery. See [docs/research-delegation.md](docs/research-delegation.md) for setup, lifecycle, security boundaries, and recovery, and [docs/research-delegation-design.md](docs/research-delegation-design.md) for the binding design spec.

## Delegated research to OpenCode

Codex can submit bounded research tasks to a local OpenCode executor and receive structured findings plus report artifacts. See [Research delegation](docs/research-delegation.md) for setup, lifecycle, security boundaries, and recovery.

## Development

```bash
bun install
bun run test        # full test suite
bun run typecheck   # tsc --noEmit
```

Requires [Bun](https://bun.sh) 1.4+ and a local OpenCode executable. No other runtime dependencies (zod is the only library dependency).
