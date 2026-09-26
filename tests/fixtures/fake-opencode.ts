import { spawn } from "node:child_process";
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const mode = process.env.FAKE_OPENCODE_MODE ?? "success";
const tracePath = process.env.FAKE_OPENCODE_TRACE_PATH ?? "";
const record = (value: Record<string, unknown>) => {
  if (tracePath) appendFileSync(tracePath, `${JSON.stringify(value)}\n`);
};
const markRunning = () => {
  if (process.env.FAKE_OPENCODE_PID_PATH) writeFileSync(process.env.FAKE_OPENCODE_PID_PATH, String(process.pid));
};
const markTreeRunning = () => {
  markRunning();
  const scriptPath = process.argv[1];
  if (!scriptPath) throw new Error("fixture script path is unavailable");
  const child = spawn(process.execPath, [scriptPath, "--descendant"], {
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  if (process.env.FAKE_OPENCODE_TREE_READY_PATH) {
    writeFileSync(process.env.FAKE_OPENCODE_TREE_READY_PATH, JSON.stringify({ parentPid: process.pid, childPid: child.pid }));
  }
};

record({ kind: "invocation", args, cwd: process.cwd(), pid: process.pid });

if (args.includes("--descendant")) {
  await new Promise(() => {});
}
if (args.includes("--version")) {
  if (mode === "probe-hang" || mode === "probe-tree") {
    if (mode === "probe-tree") markTreeRunning();
    else markRunning();
    await new Promise(() => {});
  }
  process.stdout.write("1.18.32\n");
  process.exit(0);
}
if (args[0] === "models") {
  if (process.env.FAKE_OPENCODE_ABORT_MARKER) writeFileSync(process.env.FAKE_OPENCODE_ABORT_MARKER, "aborted");
  if (process.env.FAKE_OPENCODE_REMOVE_CWD) {
    rmSync(process.env.FAKE_OPENCODE_REMOVE_CWD, { recursive: true, force: true });
  }
  process.stdout.write("provider/model-fast\nprovider/model-slow\n");
  process.exit(0);
}
if (args[0] === "run" && args.includes("--help")) {
  process.stdout.write("--format\n--model\n--dir\n--title\n");
  process.exit(0);
}
if (args[0] !== "run") {
  process.stderr.write("unsupported fake command\n");
  process.exit(2);
}

const prompt = await Bun.stdin.text();
const permission = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
  permission?: Record<string, unknown>;
};
const workspace = args[args.indexOf("--dir") + 1];
record({
  kind: "run-start",
  args,
  cwd: process.cwd(),
  prompt,
  configText: process.env.OPENCODE_CONFIG_CONTENT ?? "",
  pid: process.pid,
});

if (!prompt.includes("research-delegation/v1")) {
  process.stderr.write("missing trusted contract\n");
  process.exit(3);
}
if (permission.permission?.external_directory !== "deny" || permission.permission?.bash !== "deny") {
  process.stderr.write("missing permission contract\n");
  process.exit(4);
}
if (!workspace) {
  process.stderr.write("missing --dir\n");
  process.exit(5);
}

if (mode === "run-tree" || mode === "run-tree-exit") {
  markTreeRunning();
  if (mode === "run-tree-exit") {
    const releasePath = join(workspace, "release");
    while (!existsSync(releasePath)) await Bun.sleep(10);
    process.exit(0);
  }
  await new Promise(() => {});
}
if (mode === "run-tree-late") {
  markRunning();
  const releasePath = join(workspace, "release");
  while (!existsSync(releasePath)) await Bun.sleep(10);
  markTreeRunning();
  process.exit(0);
}
if (mode === "crash") {
  process.stderr.write("authorization: Bearer CRASH_SECRET api_key: CRASH_API_KEY sk-abcdefghijklmnop OPENAI_API_KEY=OPENAI_CANARY X-Api-Key: HEADER_CANARY\n");
  process.exit(7);
}
if (mode === "provider-error") {
  process.stdout.write(`${JSON.stringify({
    type: "error",
    sessionID: "ses_error",
    error: { name: "ProviderError", message: "synthetic provider failure" },
  })}\n`);
  process.exit(0);
}
if (mode === "malformed") {
  markRunning();
  process.stdout.write("{not-json\n");
  await new Promise(() => {});
}
if (mode === "no-final") {
  process.stdout.write(`${JSON.stringify({
    type: "step_finish",
    sessionID: "ses_fake_research",
    part: { type: "step-finish", reason: "stop" },
  })}\n`);
  process.exit(0);
}
if (mode === "intermediate-only") {
  process.stdout.write(`${JSON.stringify({
    type: "step_start",
    sessionID: "ses_intermediate",
    part: { type: "step-start" },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: "text",
    sessionID: "ses_intermediate",
    part: {
      type: "text",
      text: JSON.stringify({
        summary: "checkpoint",
        feasibility: { verdict: "unknown", notes: "" },
        evidence: [],
        risks: [],
        unknowns: ["fixture"],
        reportPath: "report.md",
      }),
    },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: "step_finish",
    sessionID: "ses_intermediate",
    part: { type: "step-finish", reason: "tool-calls" },
  })}\n`);
  process.exit(0);
}
if (mode === "hang") {
  markRunning();
  await new Promise(() => {});
}
if (mode === "stdout-limit") {
  markRunning();
  const oversizedLine = `${JSON.stringify({
    type: "text",
    sessionID: "ses_fake_research",
    part: { type: "text", text: "x".repeat(8 * 1024 * 1024 + 1024) },
  })}\n`;
  await new Promise<void>(resolve => process.stdout.write(oversizedLine, () => resolve()));
  await new Promise(() => {});
}
if (mode === "stderr-overflow") {
  process.stderr.write(`${"A".repeat(180_000)}\nauthorization: Bearer STDERR_SECRET\napi_key: STDERR_API_KEY\nOPENAI_API_KEY=STDERR_OPENAI_CANARY\nX-Api-Key: STDERR_HEADER_CANARY\nsk-abcdefghijklmnop\n`);
  process.stderr.write(`ghp_CANARYGHPabcdefghijklmnopqrstuvwxyz AKIACANARYAKIAEXAMPLE123 xoxb-CANARYXOXBBBBBBBBBBBBBB eyJCANARYJWTciOiJIUzI1NiJ9.eyJCANARYJWTpayload12345.sigCANARYJWTsignature9 {"authorization":"Bearer JSONFORM_SECRET_VALUE_123"} redaction-prose-marker\n`);
  process.stderr.write(`stderr-tail-marker\n`);
  process.exit(23);
}

await Bun.write(join(workspace, "partial-report.md"), "# Partial research output\n\nStatus: incomplete\n");
await Bun.write(join(workspace, "report.md"), "# Detailed report\n\nInline fact verified by the fake executor.\n");
const finalText = mode === "bad-report"
  ? "not-json"
  : JSON.stringify({
      summary: "方案可行。",
      feasibility: { verdict: "feasible", notes: "基于内联事实。" },
      evidence: [{ claim: "内联事实", source: "https://example.com/source", observedAt: "2026-09-24" }],
      risks: [],
      unknowns: [],
      reportPath: "report.md",
    });
const sessionId = "ses_fake_research";
const emit = (type: string, data: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify({ type, timestamp: Date.now(), sessionID: sessionId, ...data })}\n`);
};
emit("step_start", { part: { type: "step-start" } });
emit("text", { part: { type: "text", text: "checkpoint" } });
emit("step_finish", { part: { type: "step-finish", reason: "tool-calls" } });
emit("step_start", { part: { type: "step-start" } });
emit("text", { part: { type: "text", text: finalText } });
emit("step_finish", { part: { type: "step-finish", reason: "stop" } });
