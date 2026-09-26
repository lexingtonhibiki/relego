import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RESEARCH_PROTOCOL_VERSION, type ResearchExecutor } from "../src/contracts";
import { createResearchConfig } from "../src/config";
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
  try {
    const initial = createTestConfig(root);
    service = startResearchService(initial, {
      executor: async () => { throw new Error("fixture failure"); },
      models: new Set(["provider/model-fast"]),
    });
    const port = service.server.port;
    if (port === undefined) throw new Error("research service did not receive a port");
    writeTestConfig(root, { ...initial, port });
    writeTestRequest(requestPath, "fail");
    const original = readFileSync(requestPath);
    const result = await runCli(["--home", root, "research", "run", requestPath]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).tasks[0].status).toBe("failed");
    expect(readFileSync(requestPath).equals(original)).toBeTrue();
  } finally {
    await service?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupting a research CLI client does not cancel accepted service work", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-cli-interrupt-"));
  const requestPath = join(root, "request.json");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  let taskId = "";
  let aborted = false;
  let service: ReturnType<typeof startResearchService> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const initial = createTestConfig(root);
    service = startResearchService(initial, {
      executor: async job => {
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
    release();
    const deadline = Date.now() + 10_000;
    let status = service.coordinator.getTask(taskId).status;
    while ((status === "queued" || status === "running" || status === "cancelling") && Date.now() < deadline) {
      await Bun.sleep(10);
      status = service.coordinator.getTask(taskId).status;
    }
    expect(status).toBe("succeeded");
    expect(aborted).toBeFalse();
  } finally {
    release();
    child?.kill("SIGKILL");
    await service?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
