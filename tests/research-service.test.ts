import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESEARCH_PROTOCOL_VERSION, type ResearchExecutor, type ResearchTaskSnapshot } from "../src/contracts";
import { createResearchConfig } from "../src/config";
import { startResearchService } from "../src/service";
import { ResearchStore } from "../src/store";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-service-"));
  const config = createResearchConfig({
    port: 0,
    workspaceRoot: join(root, "jobs"),
    opencodeCommand: [process.execPath],
    defaultModel: "provider/model-fast",
    defaultTimeoutMs: 1_000,
    maxConcurrency: 2,
    heartbeatMs: 10_000,
  });
  let calls = 0;
  const executor: ResearchExecutor = async job => {
    calls += 1;
    if (job.prompt.includes("fail")) throw new Error("synthetic service failure");
    await Bun.write(join(job.workspacePath, "report.md"), "# report\n");
    return { finalText: JSON.stringify({
      summary: "ok",
      feasibility: { verdict: "feasible", notes: "" },
      evidence: [],
      risks: [],
      unknowns: ["fixture"],
      reportPath: "report.md",
    }) };
  };
  const service = startResearchService(config, { executor, models: new Set(["provider/model-fast"]) });
  return { root, config: { ...config, port: service.server.port }, service, calls: () => calls };
}

function persistedQueuedTask(store: ResearchStore): ResearchTaskSnapshot {
  const taskId = "rt_11111111111111111111111111111111";
  const batchId = "rb_11111111111111111111111111111111";
  return {
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    taskId,
    batchId,
    clientKey: "queued",
    description: "queued before bind",
    effectiveModel: "provider/model-fast",
    timeoutMs: 1_000,
    status: "queued",
    createdAt: "2026-09-24T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    heartbeatAt: null,
    workspacePath: store.workspacePath(taskId),
    report: null,
    artifacts: [],
    error: null,
  };
}

test("bind failure starts no executor", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-bind-failure-"));
  const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("blocked") });
  if (blocker.port === undefined) throw new Error("blocker did not receive a port");
  const config = createResearchConfig({
    port: blocker.port,
    workspaceRoot: join(root, "jobs"),
    opencodeCommand: [process.execPath],
    defaultModel: "provider/model-fast",
    defaultTimeoutMs: 1_000,
    maxConcurrency: 1,
    heartbeatMs: 1_000,
  });
  const store = new ResearchStore(config.workspaceRoot);
  const task = persistedQueuedTask(store);
  store.saveTask(task);
  let calls = 0;
  try {
    expect(() => startResearchService(config, {
      executor: async () => {
        calls += 1;
        throw new Error("must not execute");
      },
      models: new Set(["provider/model-fast"]),
    })).toThrow();
    expect(calls).toBe(0);
    expect(store.getTask(task.taskId)?.status).toBe("queued");
  } finally {
    blocker.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("research API requires bearer auth and rejects invalid batches before execution", async () => {
  const { root, config, service } = await fixture();
  const endpoint = `http://127.0.0.1:${service.server.port}`;
  try {
    const unauthorized = await fetch(`${endpoint}/v1/research/batches`, {
      method: "POST",
      body: JSON.stringify({ protocolVersion: RESEARCH_PROTOCOL_VERSION, tasks: [{ description: "one" }] }),
    });
    expect(unauthorized.status).toBe(401);
    const invalid = await fetch(`${endpoint}/v1/research/batches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ protocolVersion: RESEARCH_PROTOCOL_VERSION, tasks: [] }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("invalid_request");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unavailable model rejects the whole batch before executor invocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-service-model-"));
  const config = createResearchConfig({
    port: 0,
    workspaceRoot: join(root, "jobs"),
    opencodeCommand: [process.execPath],
    defaultModel: "provider/model-fast",
    defaultTimeoutMs: 1_000,
    maxConcurrency: 1,
    heartbeatMs: 1_000,
  });
  let calls = 0;
  const service = startResearchService(config, {
    executor: async job => {
      calls += 1;
      await Bun.write(join(job.workspacePath, "report.md"), "# report\n");
      return { finalText: JSON.stringify({
        summary: "ok",
        feasibility: { verdict: "feasible", notes: "" },
        evidence: [],
        risks: [],
        unknowns: ["fixture"],
        reportPath: "report.md",
      }) };
    },
    models: new Set(["provider/model-fast"]),
  });
  try {
    const duplicate = await fetch(`http://127.0.0.1:${service.server.port}/v1/research/batches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocolVersion: RESEARCH_PROTOCOL_VERSION,
        tasks: [
          { clientKey: "same", description: "one" },
          { clientKey: "same", description: "two" },
        ],
      }),
    });
    expect(duplicate.status).toBe(400);
    expect((await duplicate.json()).error.code).toBe("invalid_request");
    expect(calls).toBe(0);

    const response = await fetch(`http://127.0.0.1:${service.server.port}/v1/research/batches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocolVersion: RESEARCH_PROTOCOL_VERSION,
        tasks: [{ clientKey: "one", description: "one", model: "provider/missing" }],
      }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("model_unavailable");
    expect(calls).toBe(0);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid wait query values are rejected with stable 400", async () => {
  const { root, config, service } = await fixture();
  const endpoint = `http://127.0.0.1:${service.server.port}`;
  try {
    const response = await fetch(`${endpoint}/v1/research/batches?wait=garbage`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ protocolVersion: RESEARCH_PROTOCOL_VERSION, tasks: [{ description: "one" }] }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("chunked research bodies are bounded before execution", async () => {
  const { root, config, service, calls } = await fixture();
  const endpoint = `http://127.0.0.1:${service.server.port}`;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1024));
      controller.close();
    },
  });
  try {
    const response = await fetch(`${endpoint}/v1/research/batches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({ code: "invalid_request" });
    expect(calls()).toBe(0);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("encoded research bodies are rejected before execution", async () => {
  const { root, config, service, calls } = await fixture();
  const endpoint = `http://127.0.0.1:${service.server.port}`;
  const body = Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify({
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    tasks: [{ description: "encoded" }],
  })));
  try {
    const response = await fetch(`${endpoint}/v1/research/batches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
        "content-encoding": "zstd",
      },
      body: new Uint8Array(body),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({ code: "invalid_request" });
    expect(calls()).toBe(0);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync and async batch routes return the same task contract", async () => {
  const { root, config, service } = await fixture();
  const endpoint = `http://127.0.0.1:${service.server.port}`;
  const headers = {
    authorization: `Bearer ${config.controlToken}`,
    "content-type": "application/json",
  };
  const body = JSON.stringify({
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    tasks: [{ clientKey: "one", description: "one" }],
  });
  try {
    const sync = await fetch(`${endpoint}/v1/research/batches?wait=true`, { method: "POST", headers, body });
    expect(sync.status).toBe(200);
    const syncBody = await sync.json() as { batchId: string; waitCompleted: boolean; tasks: Array<{ status: string }> };
    expect(syncBody.waitCompleted).toBeTrue();
    expect(syncBody.tasks[0]?.status).toBe("succeeded");
    const asyncResponse = await fetch(`${endpoint}/v1/research/batches?wait=false`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        protocolVersion: RESEARCH_PROTOCOL_VERSION,
        tasks: [{ clientKey: "two", description: "two" }],
      }),
    });
    expect(asyncResponse.status).toBe(202);
    expect((await asyncResponse.json()).tasks[0].taskId).toMatch(/^rt_[a-f0-9]{32}$/);
    const status = await fetch(`${endpoint}/v1/research/tasks/${syncBody.batchId}`, { headers });
    expect(status.status).toBe(404);
    const list = await fetch(`${endpoint}/v1/research/batches`, { headers });
    expect(list.status).toBe(404);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("idempotency conflict is 409 and unknown cancel target is 404", async () => {
  const { root, config, service } = await fixture();
  const endpoint = `http://127.0.0.1:${service.server.port}`;
  const headers = {
    authorization: `Bearer ${config.controlToken}`,
    "content-type": "application/json",
    "idempotency-key": "idem-1234567890",
  };
  const request = JSON.stringify({
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    tasks: [{ description: "one" }],
  });
  try {
    const first = await fetch(`${endpoint}/v1/research/batches?wait=true`, { method: "POST", headers, body: request });
    expect(first.status).toBe(200);
    const changed = await fetch(`${endpoint}/v1/research/batches?wait=true`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        protocolVersion: RESEARCH_PROTOCOL_VERSION,
        tasks: [{ description: "changed" }],
      }),
    });
    expect(changed.status).toBe(409);
    expect((await changed.json()).error.code).toBe("idempotency_conflict");
    const missing = await fetch(`${endpoint}/v1/research/tasks/rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
    });
    expect(missing.status).toBe(404);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("client disconnect does not cancel accepted research", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-disconnect-"));
  const config = createResearchConfig({
    port: 0,
    workspaceRoot: join(root, "jobs"),
    opencodeCommand: [process.execPath],
    defaultModel: "provider/model-fast",
    defaultTimeoutMs: 1_000,
    maxConcurrency: 1,
    heartbeatMs: 1_000,
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  let acceptedTaskId = "";
  let observedAbort = false;
  const executor: ResearchExecutor = async job => {
    acceptedTaskId = job.taskId;
    job.signal.addEventListener("abort", () => { observedAbort = true; }, { once: true });
    markStarted();
    await gate;
    await Bun.write(join(job.workspacePath, "report.md"), "# report\n");
    return { finalText: JSON.stringify({
      summary: "ok",
      feasibility: { verdict: "feasible", notes: "" },
      evidence: [],
      risks: [],
      unknowns: ["fixture"],
      reportPath: "report.md",
    }) };
  };
  const service = startResearchService(config, { executor, models: new Set(["provider/model-fast"]) });
  const endpoint = `http://127.0.0.1:${service.server.port}`;
  const controller = new AbortController();
  try {
    const accepted = fetch(`${endpoint}/v1/research/batches?wait=true`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocolVersion: RESEARCH_PROTOCOL_VERSION,
        tasks: [{ clientKey: "one", description: "one" }],
      }),
    });
    await started;
    controller.abort();
    await accepted.catch(() => undefined);
    expect(observedAbort).toBeFalse();
    release();
    let task = service.coordinator.getTask(acceptedTaskId);
    while (task.status === "queued" || task.status === "running" || task.status === "cancelling") {
      await Bun.sleep(1);
      task = service.coordinator.getTask(acceptedTaskId);
    }
    expect(task.status).toBe("succeeded");
  } finally {
    release();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("health reports the persisted active task count", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-health-active-"));
  const config = createResearchConfig({
    port: 0,
    workspaceRoot: join(root, "jobs"),
    opencodeCommand: [process.execPath],
    defaultModel: "provider/model-fast",
    defaultTimeoutMs: 1_000,
    maxConcurrency: 1,
    heartbeatMs: 1_000,
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const service = startResearchService(config, {
    executor: async job => {
      markStarted();
      await gate;
      await Bun.write(join(job.workspacePath, "report.md"), "# report\n");
      return { finalText: JSON.stringify({
        summary: "ok",
        feasibility: { verdict: "feasible", notes: "" },
        evidence: [],
        risks: [],
        unknowns: ["fixture"],
        reportPath: "report.md",
      }) };
    },
    models: new Set(["provider/model-fast"]),
  });
  const endpoint = `http://127.0.0.1:${service.server.port}`;
  try {
    const response = await fetch(`${endpoint}/v1/research/batches?wait=false`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocolVersion: RESEARCH_PROTOCOL_VERSION,
        tasks: [{ clientKey: "health-active", description: "health active" }],
      }),
    });
    expect(response.status).toBe(202);
    const batch = await response.json() as { batchId: string };
    await started;
    const health = await fetch(`${endpoint}/healthz`);
    expect(health.status).toBe(200);
    expect((await health.json()).activeTasks).toBe(1);
    release();
    await service.coordinator.waitForBatch(batch.batchId);
    const settledHealth = await fetch(`${endpoint}/healthz`);
    expect((await settledHealth.json()).activeTasks).toBe(0);
  } finally {
    release();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch responses identify keyed and non-keyed submissions", async () => {
  const { root, config, service } = await fixture();
  const endpoint = `http://127.0.0.1:${service.server.port}`;
  const headers = {
    authorization: `Bearer ${config.controlToken}`,
    "content-type": "application/json",
  };
  const submit = (clientKey: string, idempotencyKey?: string) => fetch(`${endpoint}/v1/research/batches?wait=false`, {
    method: "POST",
    headers: {
      ...headers,
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    body: JSON.stringify({
      protocolVersion: RESEARCH_PROTOCOL_VERSION,
      tasks: [{ clientKey, description: clientKey }],
    }),
  });
  try {
    const nonIdempotent = await submit("header-absent");
    expect(nonIdempotent.status).toBe(202);
    expect(nonIdempotent.headers.get("Idempotency-Status")).toBe("non-idempotent");
    const keyed = await submit("header-keyed", "idem-header-1234567890");
    expect(keyed.status).toBe(202);
    expect(keyed.headers.get("Idempotency-Status")).toBe("idempotent");
    const blank = await submit("header-blank", "   ");
    expect(blank.status).toBe(202);
    expect(blank.headers.get("Idempotency-Status")).toBe("non-idempotent");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
