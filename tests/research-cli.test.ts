import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RESEARCH_PROTOCOL_VERSION, type ResearchBatchSnapshot, type ResearchExecutor } from "../src/contracts";
import { createResearchConfig } from "../src/config";
import { createOpenCodeExecutor, probeOpenCode } from "../src/opencode";
import { startResearchService } from "../src/service";

setDefaultTimeout(60_000);

async function runCli(args: string[]) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function createTestConfig(root: string, port = 0) {
  return createResearchConfig({
    port,
    workspaceRoot: join(root, "jobs"),
    opencodeCommand: [process.execPath],
    defaultModel: "provider/model-fast",
    defaultTimeoutMs: 1_000,
    maxConcurrency: 1,
    heartbeatMs: 10_000,
  });
}

function writeTestConfig(root: string, config: ReturnType<typeof createTestConfig>): void {
  mkdirSync(join(root, "research"), { recursive: true });
  writeFileSync(join(root, "research", "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function writeTestRequest(path: string, description = "one"): void {
  writeFileSync(path, `${JSON.stringify({
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    tasks: [{ clientKey: "one", description }],
  })}\n`);
}

test("research run and submit forward explicit keys and otherwise generate fresh UUIDs", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-cli-keys-"));
  const received: Array<{ method: string; path: string; key: string | null; body: unknown }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      received.push({
        method: request.method,
        path: url.pathname + url.search,
        key: request.headers.get("idempotency-key"),
        body: await request.json(),
      });
      return Response.json({ tasks: [] }, { status: url.searchParams.get("wait") === "true" ? 200 : 202 });
    },
  });
  try {
    writeTestConfig(root, createTestConfig(root, server.port));
    const requestPath = join(root, "request.json");
    writeTestRequest(requestPath);
    const generated: string[] = [];
    for (const command of ["run", "submit"]) {
      for (const args of [
        [requestPath, "--idempotency-key", "retry-key"],
        ["--idempotency-key", " retry-key ", requestPath],
        [requestPath],
        [requestPath],
      ]) {
        const result = await runCli(["--home", root, "research", command, ...args]);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        const request = received.at(-1)!;
        expect(request.method).toBe("POST");
        expect(request.path).toBe(`/v1/research/batches?wait=${command === "run"}`);
        expect(request.body).toEqual(JSON.parse(readFileSync(requestPath, "utf8")));
        if (args.includes("--idempotency-key")) {
          expect(request.key).toBe("retry-key");
        } else {
          expect(request.key).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
          generated.push(request.key!);
        }
      }
    }
    expect(received).toHaveLength(8);
    expect(new Set(generated).size).toBe(4);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("research run and submit reject missing or blank idempotency keys before submission", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-cli-invalid-key-"));
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests += 1;
      return Response.json({ tasks: [] });
    },
  });
  try {
    writeTestConfig(root, createTestConfig(root, server.port));
    const requestPath = join(root, "request.json");
    writeTestRequest(requestPath);
    for (const command of ["run", "submit"]) {
      for (const [values, message] of [
        [[], "--idempotency-key requires a value"],
        [[""], "--idempotency-key requires a value"],
        [["--unknown"], "--idempotency-key requires a value"],
        [[" \t "], "--idempotency-key must not be blank"],
      ] as const) {
        const result = await runCli(["--home", root, "research", command, requestPath, "--idempotency-key", ...values]);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(message);
      }
    }
    expect(requests).toBe(0);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

for (const command of ["run", "submit"]) {
  test(`research ${command} retries reuse one execution and reject conflicting requests`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ccweb-research-cli-retry-"));
    let service: ReturnType<typeof startResearchService> | undefined;
    let calls = 0;
    try {
      const initial = { ...createTestConfig(root), defaultTimeoutMs: 10_000 };
      const capabilities = probeOpenCode(
        [process.execPath, resolve(import.meta.dir, "fixtures/fake-opencode.ts")],
        initial.defaultModel,
      );
      const executor = createOpenCodeExecutor(capabilities);
      service = startResearchService(initial, {
        executor: async job => { calls += 1; return executor(job); },
        models: new Set(capabilities.models),
      });
      writeTestConfig(root, { ...initial, port: service.server.port! });
      const requestPath = join(root, "request.json");
      writeTestRequest(requestPath);
      const args = ["--home", root, "research", command, requestPath, "--idempotency-key", "retry-key"];
      const first = await runCli(args);
      expect(first.exitCode).toBe(0);
      expect(first.stderr).toBe("");
      const original = JSON.parse(first.stdout) as ResearchBatchSnapshot;
      const retry = await runCli(args);
      expect(retry.exitCode).toBe(0);
      expect(retry.stderr).toBe("");
      const repeated = JSON.parse(retry.stdout) as ResearchBatchSnapshot;
      expect(repeated.batchId).toBe(original.batchId);
      expect(repeated.tasks[0]?.taskId).toBe(original.tasks[0]?.taskId);
      const completed = await service.coordinator.waitForBatch(original.batchId);
      expect(completed.tasks[0]?.status).toBe("succeeded");
      expect(calls).toBe(1);

      // A submit can also be resumed with run, using the same request and key.
      const resumed = await runCli(["--home", root, "research", "run", requestPath, "--idempotency-key", "retry-key"]);
      expect(resumed.exitCode).toBe(0);
      expect(JSON.parse(resumed.stdout)).toEqual(completed);
      expect(calls).toBe(1);

      writeTestRequest(requestPath, "changed request");
      const conflict = await runCli(args);
      expect(conflict.exitCode).toBe(1);
      expect(conflict.stdout).toBe("");
      expect(conflict.stderr).toContain("Research service returned 409:");
      expect(conflict.stderr).toContain('"code":"idempotency_conflict"');
      expect(calls).toBe(1);

      // Omitting the flag still creates a fresh batch for each invocation.
      writeTestRequest(requestPath);
      const batchIds = [original.batchId];
      const taskIds = [original.tasks[0]!.taskId];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const fresh = await runCli(["--home", root, "research", command, requestPath]);
        expect(fresh.exitCode).toBe(0);
        const snapshot = JSON.parse(fresh.stdout) as ResearchBatchSnapshot;
        batchIds.push(snapshot.batchId);
        taskIds.push(snapshot.tasks[0]!.taskId);
        expect((await service.coordinator.waitForBatch(snapshot.batchId)).tasks[0]?.status).toBe("succeeded");
      }
      expect(new Set(batchIds).size).toBe(3);
      expect(new Set(taskIds).size).toBe(3);
      expect(calls).toBe(3);
    } finally {
      await service?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("research run, submit, status, and cancel use one JSON stdout document", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-cli-"));
  const requestPath = join(root, "request.json");
  const executor: ResearchExecutor = async job => {
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
  let service: ReturnType<typeof startResearchService> | undefined;
  try {
    const initial = createResearchConfig({
      port: 0,
      workspaceRoot: join(root, "jobs"),
      opencodeCommand: [process.execPath],
      defaultModel: "provider/model-fast",
      defaultTimeoutMs: 1_000,
      maxConcurrency: 1,
      heartbeatMs: 10_000,
    });
    service = startResearchService(initial, {
      executor,
      models: new Set(["provider/model-fast"]),
    });
    const config = { ...initial, port: service.server.port };
    mkdirSync(join(root, "research"), { recursive: true });
    writeFileSync(join(root, "research", "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(requestPath, `${JSON.stringify({
      protocolVersion: RESEARCH_PROTOCOL_VERSION,
      tasks: [{ clientKey: "one", description: "one" }],
    })}\n`);
    const run = await runCli(["--home", root, "research", "run", requestPath]);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    const body = JSON.parse(run.stdout) as { batchId: string; tasks: Array<{ taskId: string; status: string }> };
    expect(body.tasks[0]?.status).toBe("succeeded");

    const submitted = await runCli(["--home", root, "research", "submit", requestPath]);
    expect(submitted.exitCode).toBe(0);
    const submittedBody = JSON.parse(submitted.stdout) as { tasks: Array<{ taskId: string; status: string }> };
    expect(submittedBody.tasks[0]?.taskId).toMatch(/^rt_[a-f0-9]{32}$/);

    const status = await runCli(["--home", root, "research", "status", submittedBody.tasks[0]!.taskId]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout).taskId).toBe(submittedBody.tasks[0]!.taskId);
    const cancel = await runCli(["--home", root, "research", "cancel", submittedBody.tasks[0]!.taskId]);
    expect(cancel.exitCode).toBe(0);
    expect(["succeeded", "cancelled"]).toContain(JSON.parse(cancel.stdout).status);
    expect(readFileSync(requestPath, "utf8")).toContain("description");
  } finally {
    await service?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("research setup, doctor, and serve reject trailing arguments before side effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-cli-arguments-"));
  try {
    const results = await Promise.all([
      runCli(["--home", root, "research", "setup", "--model", "provider/model-fast", "trailing"]),
      runCli(["--home", root, "research", "doctor", "trailing"]),
      runCli(["--home", root, "research", "serve", "trailing"]),
    ]);
    for (const result of results) {
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Unknown research arguments: trailing");
    }
    expect(existsSync(join(root, "research", "config.json"))).toBeFalse();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("research setup rejects port zero without replacing an existing config", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-cli-port-zero-"));
  try {
    const config = createTestConfig(root, 17_842);
    writeTestConfig(root, config);
    const configPath = join(root, "research", "config.json");
    const original = readFileSync(configPath);
    const result = await runCli([
      "--home", root,
      "research", "setup",
      "--model", "provider/model-fast",
      "--opencode", join(root, "missing-opencode"),
      "--port", "0",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--port must be an integer from 1 to 65535");
    expect(readFileSync(configPath).equals(original)).toBeTrue();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("research submit rejects non-JSON success responses and preserves JSON error envelopes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-cli-response-"));
  let mode: "invalid" | "error" = "invalid";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (mode === "invalid") return new Response("not-json", { status: 202 });
      return Response.json({ error: { code: "idempotency_conflict", message: "conflict" } }, { status: 409 });
    },
  });
  try {
    const config = createTestConfig(root, server.port);
    writeTestConfig(root, config);
    const requestPath = join(root, "request.json");
    writeTestRequest(requestPath);
    const invalid = await runCli(["--home", root, "research", "submit", requestPath]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("Research service returned non-JSON output");

    mode = "error";
    const envelope = await runCli(["--home", root, "research", "submit", requestPath]);
    expect(envelope.exitCode).toBe(1);
    expect(envelope.stdout).toBe("");
    expect(envelope.stderr).toContain(
      "Research service returned 409: {\"error\":{\"code\":\"idempotency_conflict\",\"message\":\"conflict\"}}",
    );
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("research run prints a failed batch and exits 1 without stderr diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-cli-failed-"));
  const requestPath = join(root, "request.json");
  let service: ReturnType<typeof startResearchService> | undefined;
  let calls = 0;
  try {
    const initial = createTestConfig(root);
    service = startResearchService(initial, {
      executor: async () => { calls += 1; throw new Error("fixture failure"); },
      models: new Set(["provider/model-fast"]),
    });
    const port = service.server.port;
    if (port === undefined) throw new Error("research service did not receive a port");
    writeTestConfig(root, { ...initial, port });
    writeTestRequest(requestPath, "fail");
    const original = readFileSync(requestPath);
    const args = ["--home", root, "research", "run", requestPath, "--idempotency-key", "failed-batch"];
    const result = await runCli(args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).tasks[0].status).toBe("failed");
    expect(readFileSync(requestPath).equals(original)).toBeTrue();
    const retry = await runCli(args);
    expect(retry.exitCode).toBe(1);
    expect(retry.stderr).toBe("");
    expect(JSON.parse(retry.stdout)).toEqual(JSON.parse(result.stdout));
    expect(calls).toBe(1);
  } finally {
    await service?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retrying an interrupted research CLI client with the same key does not duplicate work", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-cli-interrupt-"));
  const requestPath = join(root, "request.json");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  let taskId = "";
  let calls = 0;
  let aborted = false;
  let service: ReturnType<typeof startResearchService> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const initial = { ...createTestConfig(root), defaultTimeoutMs: 10_000 };
    service = startResearchService(initial, {
      executor: async job => {
        calls += 1;
        taskId = job.taskId;
        job.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
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
    const port = service.server.port;
    if (port === undefined) throw new Error("research service did not receive a port");
    writeTestConfig(root, { ...initial, port });
    writeTestRequest(requestPath, "interrupt");
    const spawned = Bun.spawn([
      process.execPath,
      resolve(import.meta.dir, "../src/cli.ts"),
      "--home", root,
      "research", "run", requestPath,
      "--idempotency-key", "interrupted-client",
    ], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    child = spawned;
    const stdout = new Response(spawned.stdout).text();
    const stderr = new Response(spawned.stderr).text();
    await started;
    spawned.kill("SIGINT");
    const exitCode = await spawned.exited;
    expect(exitCode).not.toBe(0);
    expect(await stdout).toBe("");
    expect(await stderr).toBe("");
    const resumed = await runCli([
      "--home", root, "research", "submit", requestPath,
      "--idempotency-key", "interrupted-client",
    ]);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.stderr).toBe("");
    expect(JSON.parse(resumed.stdout).tasks[0]).toMatchObject({ taskId, status: "running" });
    expect(calls).toBe(1);
    release();
    const deadline = Date.now() + 10_000;
    let status = service.coordinator.getTask(taskId).status;
    while ((status === "queued" || status === "running" || status === "cancelling") && Date.now() < deadline) {
      await Bun.sleep(10);
      status = service.coordinator.getTask(taskId).status;
    }
    expect(status).toBe("succeeded");
    expect(aborted).toBeFalse();
    const retry = await runCli([
      "--home", root, "research", "run", requestPath,
      "--idempotency-key", "interrupted-client",
    ]);
    expect(retry.exitCode).toBe(0);
    expect(retry.stderr).toBe("");
    expect(JSON.parse(retry.stdout).tasks[0]).toMatchObject({ taskId, status: "succeeded" });
    expect(calls).toBe(1);
  } finally {
    release();
    child?.kill("SIGKILL");
    await service?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  ["unrelated service", { status: "ok", service: "other-service" }, 200, false],
  ["unhealthy gateway", { status: "degraded", service: "relego" }, 200, false],
  ["missing identity", { status: "ok" }, 200, false],
  ["null body", null, 200, false],
  ["array body", [], 200, false],
  ["HTTP failure", { status: "ok", service: "relego" }, 503, false],
  ["healthy gateway", { status: "ok", service: "relego" }, 200, true],
] as const)("research doctor checks health identity and status: %s", async (_label, body, status, healthy) => {
  const root = mkdtempSync(join(tmpdir(), "relego-doctor-health-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(new URL(request.url).pathname).toBe("/healthz");
      return Response.json(body, { status });
    },
  });
  try {
    const config = createTestConfig(root, server.port);
    config.opencodeCommand = [process.execPath, resolve(import.meta.dir, "fixtures/fake-opencode.ts")];
    writeTestConfig(root, config);
    const result = await runCli(["--home", root, "doctor"]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(healthy ? 0 : 1);
    const diagnostic = JSON.parse(result.stdout);
    expect(diagnostic.status).toBe(healthy ? "ok" : "degraded");
    expect(diagnostic.service).toEqual({ ok: healthy, status, body });
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});


test("research doctor recognizes the real gateway and reports an unavailable service", async () => {
  const root = mkdtempSync(join(tmpdir(), "relego-doctor-gateway-"));
  const initial = createTestConfig(root);
  initial.opencodeCommand = [process.execPath, resolve(import.meta.dir, "fixtures/fake-opencode.ts")];
  const service = startResearchService(initial, {
    executor: async () => { throw new Error("doctor must not execute research"); },
    models: new Set(["provider/model-fast"]),
  });
  try {
    const port = service.server.port;
    if (port === undefined) throw new Error("research service did not receive a port");
    writeTestConfig(root, { ...initial, port });
    const healthy = await runCli(["--home", root, "doctor"]);
    expect(healthy.exitCode).toBe(0);
    expect(healthy.stderr).toBe("");
    const diagnostic = JSON.parse(healthy.stdout);
    expect(diagnostic.status).toBe("ok");
    expect(diagnostic.service.ok).toBeTrue();
    expect(diagnostic.service.body.service).toBe("relego");
    expect(diagnostic.service.body.activeTasks).toBe(0);
    await service.stop();
    const unavailable = await runCli(["--home", root, "doctor"]);
    expect(unavailable.exitCode).toBe(1);
    expect(unavailable.stderr).toBe("");
    const failedDiagnostic = JSON.parse(unavailable.stdout);
    expect(failedDiagnostic.status).toBe("degraded");
    expect(failedDiagnostic.service.ok).toBeFalse();
    expect(failedDiagnostic.service.body.error).toBeString();
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
