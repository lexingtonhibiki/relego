import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../src/config";
import {
  RESEARCH_PROTOCOL_VERSION,
  ResearchError,
  type ResearchArtifactKind,
} from "../src/research/contracts";
import { assertRegularFileInside, buildPartialReport, parseResearchReport } from "../src/research/report";
import { ResearchStore } from "../src/research/store";

function task(taskId: string, batchId: string) {
  return {
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    taskId,
    batchId,
    description: "research",
    effectiveModel: "provider/model-fast",
    timeoutMs: 120_000,
    status: "queued" as const,
    createdAt: "2026-09-24T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    heartbeatAt: null,
    workspacePath: "",
    report: null,
    artifacts: [],
    error: null,
  };
}

function researchErrorCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ResearchError);
    return (error as ResearchError).code;
  }
}

function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

test("store repairs broad permissions across every managed directory", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-store-mode-"));
  try {
    const managed = ["jobs", "batches", "idempotency", "submissions"] as const;
    if (process.platform !== "win32") fs.chmodSync(root, 0o777);
    for (const name of managed) {
      const path = join(root, name);
      fs.mkdirSync(path, { mode: 0o777 });
      if (process.platform !== "win32") fs.chmodSync(path, 0o777);
    }
    const store = new ResearchStore(root);
    if (process.platform === "win32") {
      for (const name of managed) {
        const path = join(root, name);
        expect(fs.existsSync(path)).toBeTrue();
        const acl = spawnSync("icacls.exe", [path], { encoding: "utf8", windowsHide: true });
        expect(acl.status).toBe(0);
        expect(acl.stdout).not.toContain("(I)");
      }
    } else {
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      for (const name of managed) expect(fs.statSync(join(root, name)).mode & 0o777).toBe(0o700);
      const taskId = "rt_cccccccccccccccccccccccccccccccc";
      store.saveTask({ ...task(taskId, "rb_dddddddddddddddddddddddddddddddd"), workspacePath: store.workspacePath(taskId) });
      for (const path of [
        join(root, "jobs", taskId),
        join(root, "jobs", taskId, "artifacts"),
        join(root, "jobs", taskId, "workspace"),
      ]) expect(fs.statSync(path).mode & 0o777).toBe(0o700);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("store construction is safe on Windows without POSIX mode assertions", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-store-mode-win-"));
  try {
    if (process.platform !== "win32") return;
    for (const name of ["jobs", "batches", "idempotency", "submissions"]) fs.mkdirSync(join(root, name));
    expect(new ResearchStore(root).root).toBeTruthy();
    const acl = spawnSync("icacls.exe", [root], { encoding: "utf8", windowsHide: true });
    expect(acl.status).toBe(0);
    expect(acl.stdout).not.toContain("(I)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("store startup repairs privacy of pre-existing nested task trees", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-store-nested-"));
  try {
    const taskId = "rt_17171717171717171717171717171717";
    const nested = [
      root,
      join(root, "jobs"),
      join(root, "jobs", taskId),
      join(root, "jobs", taskId, "artifacts"),
      join(root, "jobs", taskId, "workspace"),
    ];
    if (process.platform === "win32") {
      for (const path of nested) {
        fs.mkdirSync(path, { recursive: true });
        const grant = spawnSync("icacls.exe", [path, "/grant", "*S-1-1-0:(OI)(CI)F"], { encoding: "utf8", windowsHide: true });
        expect(grant.status).toBe(0);
      }
    } else {
      for (const path of nested) {
        fs.mkdirSync(path, { recursive: true, mode: 0o777 });
        fs.chmodSync(path, 0o777);
      }
    }
    new ResearchStore(root);
    if (process.platform === "win32") {
      const listScript = "$p = $env:CCWEB_TEST_ACL_PATH; $acl = Get-Acl -LiteralPath $p; $inherited = @($acl.Access | Where-Object { $_.IsInherited }).Count; '{0}|{1}' -f @($acl.Access).Count, $inherited";
      for (const path of nested) {
        const acl = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", listScript], {
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, CCWEB_TEST_ACL_PATH: path },
        });
        expect(acl.status).toBe(0);
        expect(acl.stdout.trim()).toBe("3|0");
      }
    } else {
      for (const path of nested) expect(fs.statSync(path).mode & 0o777).toBe(0o700);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("saveTask hardens freshly created nested directories on Windows", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-store-fresh-"));
  try {
    if (process.platform !== "win32") return;
    const store = new ResearchStore(root);
    const taskId = "rt_18181818181818181818181818181818";
    store.saveTask({ ...task(taskId, "rb_19191919191919191919191919191919"), workspacePath: store.workspacePath(taskId) });
    const listScript = "$p = $env:CCWEB_TEST_ACL_PATH; $acl = Get-Acl -LiteralPath $p; $inherited = @($acl.Access | Where-Object { $_.IsInherited }).Count; '{0}|{1}' -f @($acl.Access).Count, $inherited";
    for (const path of [join(root, "jobs", taskId), join(root, "jobs", taskId, "artifacts"), join(root, "jobs", taskId, "workspace")]) {
      const acl = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", listScript], {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, CCWEB_TEST_ACL_PATH: path },
      });
      expect(acl.status).toBe(0);
      expect(acl.stdout.trim()).toBe("3|0");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("store persists task, batch, idempotency, and a gateway-owned artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-store-"));
  try {
    const store = new ResearchStore(root);
    const taskId = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const batchId = "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const workspace = store.workspacePath(taskId);
    const snapshot = { ...task(taskId, batchId), workspacePath: workspace };
    store.saveTask(snapshot);
    store.saveBatch({
      protocolVersion: RESEARCH_PROTOCOL_VERSION,
      batchId,
      idempotencyKey: "idem-1234567890",
      requestHash: "a".repeat(64),
      createdAt: snapshot.createdAt,
      taskIds: [taskId],
    });
    store.saveIdempotency({
      key: "idem-1234567890",
      requestHash: "a".repeat(64),
      batchId,
      createdAt: snapshot.createdAt,
    });
    writeFileSync(join(workspace, "report.md"), "# Detailed report\n", { mode: 0o600 });
    const artifact = store.publishArtifact(snapshot, "detailed_report");
    store.saveTask({ ...snapshot, artifacts: [artifact] });
    expect(store.getTask(taskId)).toEqual({ ...snapshot, artifacts: [artifact] });
    expect(store.getBatch(batchId)?.taskIds).toEqual([taskId]);
    expect(store.getIdempotency("idem-1234567890")?.batchId).toBe(batchId);
    expect(artifact).toMatchObject({ kind: "detailed_report", complete: true });
    expect(artifact.sha256).toBe(createHash("sha256").update("# Detailed report\n").digest("hex"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changed artifact content replaces the fixed destination through the atomic writer", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-atomic-"));
  const atomicWrite = spyOn(config, "atomicWriteFile");
  try {
    const store = new ResearchStore(root);
    const taskId = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const batchId = "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const workspace = store.workspacePath(taskId);
    const snapshot = { ...task(taskId, batchId), workspacePath: workspace };
    store.saveTask(snapshot);
    writeFileSync(join(workspace, "report.md"), "first\n", { mode: 0o600 });
    store.publishArtifact(snapshot, "detailed_report");
    atomicWrite.mockClear();

    writeFileSync(join(workspace, "report.md"), "second\n", { mode: 0o600 });
    const artifact = store.publishArtifact(snapshot, "detailed_report");
    expect(artifact.path).toBe(join(
      store.root,
      "jobs",
      taskId,
      "artifacts",
      "detailed-report.md",
    ));
    expect(artifact.sha256).toBe(createHash("sha256").update("second\n").digest("hex"));
    expect(readFileSync(artifact.path, "utf8")).toBe("second\n");
    expect(atomicWrite).toHaveBeenCalledWith(artifact.path, Buffer.from("second\n"));

    atomicWrite.mockClear();
    expect(store.publishArtifact(snapshot, "detailed_report")).toEqual(artifact);
    expect(atomicWrite).not.toHaveBeenCalled();

    writeFileSync(join(workspace, "report.md"), "third\n", { mode: 0o600 });
    atomicWrite.mockImplementationOnce(() => {
      throw Object.assign(new Error("rename failed"), { code: "EIO" });
    });
    expect(researchErrorCode(() => store.publishArtifact(snapshot, "detailed_report")))
      .toBe("resource_error");
    expect(readFileSync(artifact.path, "utf8")).toBe("second\n");
  } finally {
    atomicWrite.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-content artifact publication tightens the destination to private mode", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-artifact-mode-"));
  const chmod = spyOn(fs, "chmodSync");
  try {
    const store = new ResearchStore(root);
    const taskId = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const batchId = "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const workspace = store.workspacePath(taskId);
    const snapshot = { ...task(taskId, batchId), workspacePath: workspace };
    store.saveTask(snapshot);
    writeFileSync(join(workspace, "report.md"), "private report\n", { mode: 0o600 });
    const artifact = store.publishArtifact(snapshot, "detailed_report");
    fs.chmodSync(artifact.path, 0o644);
    chmod.mockClear();

    expect(store.publishArtifact(snapshot, "detailed_report")).toEqual(artifact);
    expect(chmod).toHaveBeenCalledWith(artifact.path, 0o600);
    if (process.platform !== "win32") {
      expect(fs.statSync(artifact.path).mode & 0o777).toBe(0o600);
    }
  } finally {
    chmod.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact publication rejects runtime kinds outside the fixed contract", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-artifact-kind-"));
  try {
    const store = new ResearchStore(root);
    const taskId = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const batchId = "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const workspace = store.workspacePath(taskId);
    const snapshot = { ...task(taskId, batchId), workspacePath: workspace };
    store.saveTask(snapshot);
    store.writePartialText(taskId, "visible");
    expect(researchErrorCode(() => store.publishArtifact(
      snapshot,
      "other" as ResearchArtifactKind,
    ))).toBe("invalid_report");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact publication maps filesystem read failures to resource errors", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-read-resource-"));
  const readFile = spyOn(fs, "readFileSync").mockImplementation(() => {
    throw Object.assign(new Error("I/O failure"), { code: "EIO" });
  });
  try {
    const store = new ResearchStore(root);
    const taskId = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const batchId = "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const workspace = store.workspacePath(taskId);
    const snapshot = { ...task(taskId, batchId), workspacePath: workspace };
    store.saveTask(snapshot);
    writeFileSync(join(workspace, "report.md"), "# Full report\n", { mode: 0o600 });
    expect(researchErrorCode(() => store.publishArtifact(snapshot, "detailed_report")))
      .toBe("resource_error");
  } finally {
    readFile.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("task persistence classifies a non-directory workspace as an unsafe path", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-workspace-file-"));
  try {
    const store = new ResearchStore(root);
    const taskId = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const batchId = "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const snapshot = { ...task(taskId, batchId), workspacePath: store.workspacePath(taskId) };
    mkdirSync(join(root, "jobs", taskId), { recursive: true });
    writeFileSync(snapshot.workspacePath, "not a directory\n");
    expect(researchErrorCode(() => store.saveTask(snapshot))).toBe("unsafe_report_path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("store maps atomic persistence failures to resource errors", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-resource-error-"));
  const atomicWrite = spyOn(config, "atomicWriteFile").mockImplementation(() => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  });
  try {
    const store = new ResearchStore(root);
    expect(researchErrorCode(() => store.saveBatch({
      protocolVersion: RESEARCH_PROTOCOL_VERSION,
      batchId: "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      idempotencyKey: null,
      requestHash: "a".repeat(64),
      createdAt: "2026-09-24T00:00:00.000Z",
      taskIds: [],
    }))).toBe("resource_error");
  } finally {
    atomicWrite.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("store classifies invalid identifiers and substituted workspaces as unsafe paths", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-invalid-path-"));
  try {
    const store = new ResearchStore(root);
    const taskId = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const batchId = "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(researchErrorCode(() => store.workspacePath("../escape"))).toBe("unsafe_report_path");
    expect(researchErrorCode(() => store.getBatch("rb_not-valid"))).toBe("unsafe_report_path");
    expect(researchErrorCode(() => store.saveTask({
      ...task(taskId, batchId),
      workspacePath: join(root, "elsewhere"),
    }))).toBe("unsafe_report_path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial report presence checks reject a pre-existing linked report path", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-partial-read-link-"));
  try {
    const store = new ResearchStore(root);
    const taskId = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const batchId = "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const snapshot = { ...task(taskId, batchId), workspacePath: store.workspacePath(taskId) };
    store.saveTask(snapshot);
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    linkDirectory(outside, join(snapshot.workspacePath, "partial-report.md"));
    expect(researchErrorCode(() => store.hasPartialReport(taskId))).toBe("unsafe_report_path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task listing rejects a pre-existing linked jobs directory", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-list-link-"));
  try {
    const store = new ResearchStore(root);
    const outside = join(root, "outside");
    rmSync(join(root, "jobs"), { recursive: true, force: true });
    mkdirSync(outside, { recursive: true });
    linkDirectory(outside, join(root, "jobs"));
    expect(researchErrorCode(() => store.listTasks())).toBe("unsafe_report_path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["task", "batch", "idempotency"])("store reads reject a pre-existing linked %s record path", name => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-read-link-"));
  try {
    const store = new ResearchStore(root);
    const taskId = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const batchId = "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const key = "idem-1234567890";
    const snapshot = { ...task(taskId, batchId), workspacePath: store.workspacePath(taskId) };
    store.saveTask(snapshot);
    store.saveBatch({
      protocolVersion: RESEARCH_PROTOCOL_VERSION,
      batchId,
      idempotencyKey: key,
      requestHash: "a".repeat(64),
      createdAt: snapshot.createdAt,
      taskIds: [taskId],
    });
    store.saveIdempotency({
      key,
      requestHash: "a".repeat(64),
      batchId,
      createdAt: snapshot.createdAt,
    });
    const digest = createHash("sha256").update(key).digest("hex");
    const path = name === "task"
      ? join(root, "jobs", taskId, "state.json")
      : name === "batch"
        ? join(root, "batches", `${batchId}.json`)
        : join(root, "idempotency", `${digest}.json`);
    const outside = join(root, "outside");
    rmSync(path);
    mkdirSync(outside, { recursive: true });
    linkDirectory(outside, path);
    const read = name === "task"
      ? () => store.getTask(taskId)
      : name === "batch"
        ? () => store.getBatch(batchId)
        : () => store.getIdempotency(key);
    expect(researchErrorCode(read)).toBe("unsafe_report_path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["workspace", "partial-report"])("partial persistence rejects a pre-existing linked %s path", name => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-partial-link-"));
  try {
    const store = new ResearchStore(root);
    const taskId = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const batchId = "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const snapshot = { ...task(taskId, batchId), workspacePath: store.workspacePath(taskId) };
    store.saveTask(snapshot);
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    if (name === "workspace") {
      rmSync(snapshot.workspacePath, { recursive: true, force: true });
      linkDirectory(outside, snapshot.workspacePath);
    } else {
      linkDirectory(outside, join(snapshot.workspacePath, "partial-report.md"));
    }
    expect(researchErrorCode(() => store.writePartialText(taskId, "visible")))
      .toBe("unsafe_report_path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("idempotency writes reject a pre-existing linked fixed record path", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-idempotency-link-"));
  try {
    const store = new ResearchStore(root);
    const key = "idem-1234567890";
    const digest = createHash("sha256").update(key).digest("hex");
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    linkDirectory(outside, join(root, "idempotency", `${digest}.json`));
    expect(researchErrorCode(() => store.saveIdempotency({
      key,
      requestHash: "a".repeat(64),
      batchId: "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      createdAt: "2026-09-24T00:00:00.000Z",
    }))).toBe("unsafe_report_path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch writes reject a pre-existing linked fixed batch path", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-batch-link-"));
  try {
    const store = new ResearchStore(root);
    const batchId = "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    linkDirectory(outside, join(root, "batches", `${batchId}.json`));
    expect(researchErrorCode(() => store.saveBatch({
      protocolVersion: RESEARCH_PROTOCOL_VERSION,
      batchId,
      idempotencyKey: null,
      requestHash: "a".repeat(64),
      createdAt: "2026-09-24T00:00:00.000Z",
      taskIds: [],
    }))).toBe("unsafe_report_path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task state writes reject a pre-existing linked fixed state path", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-state-link-"));
  try {
    const store = new ResearchStore(root);
    const taskId = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const batchId = "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const snapshot = { ...task(taskId, batchId), workspacePath: store.workspacePath(taskId) };
    store.saveTask(snapshot);
    const statePath = join(root, "jobs", taskId, "state.json");
    const outside = join(root, "outside");
    rmSync(statePath);
    mkdirSync(outside, { recursive: true });
    linkDirectory(outside, statePath);
    expect(researchErrorCode(() => store.saveTask(snapshot))).toBe("unsafe_report_path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["task", "workspace", "artifacts"])("task persistence rejects a pre-existing linked %s directory", name => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-task-link-"));
  try {
    const store = new ResearchStore(root);
    const taskId = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const batchId = "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const taskRoot = join(root, "jobs", taskId);
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    if (name === "task") linkDirectory(outside, taskRoot);
    else {
      mkdirSync(taskRoot, { recursive: true });
      linkDirectory(outside, join(taskRoot, name));
    }
    const snapshot = { ...task(taskId, batchId), workspacePath: store.workspacePath(taskId) };
    expect(researchErrorCode(() => store.saveTask(snapshot))).toBe("unsafe_report_path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["jobs", "batches", "idempotency"])("store construction rejects a pre-existing linked %s directory", name => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-root-link-"));
  try {
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    linkDirectory(outside, join(root, name));
    expect(researchErrorCode(() => new ResearchStore(root))).toBe("unsafe_report_path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact publication rejects a pre-existing linked artifacts directory", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-artifacts-link-"));
  try {
    const store = new ResearchStore(root);
    const taskId = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const batchId = "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const taskRoot = join(root, "jobs", taskId);
    const workspace = store.workspacePath(taskId);
    const outside = join(root, "outside");
    mkdirSync(taskRoot, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    linkDirectory(outside, join(taskRoot, "artifacts"));
    writeFileSync(join(workspace, "report.md"), "# Full report\n", { mode: 0o600 });
    const snapshot = { ...task(taskId, batchId), workspacePath: workspace };
    expect(researchErrorCode(() => store.publishArtifact(snapshot, "detailed_report")))
      .toBe("unsafe_report_path");
    expect(existsSync(join(outside, "detailed-report.md"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact publication rejects a pre-existing linked fixed destination", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-destination-link-"));
  try {
    const store = new ResearchStore(root);
    const taskId = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const batchId = "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const workspace = store.workspacePath(taskId);
    const snapshot = { ...task(taskId, batchId), workspacePath: workspace };
    store.saveTask(snapshot);
    writeFileSync(join(workspace, "report.md"), "# Full report\n", { mode: 0o600 });
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    const destination = join(root, "jobs", taskId, "artifacts", "detailed-report.md");
    linkDirectory(outside, destination);
    expect(researchErrorCode(() => store.publishArtifact(snapshot, "detailed_report")))
      .toBe("unsafe_report_path");
    expect(existsSync(join(outside, "detailed-report.md"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report parser accepts infeasible findings and rejects an empty report file", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-report-"));
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "report.md"), "# Full report\n", { mode: 0o600 });
    const finalText = JSON.stringify({
      summary: "不可行。",
      feasibility: { verdict: "infeasible", notes: "缺少权限。" },
      evidence: [],
      risks: [],
      unknowns: ["权限未知"],
      reportPath: "report.md",
    });
    const report = parseResearchReport(finalText, workspace);
    expect(report.feasibility.verdict).toBe("infeasible");
    writeFileSync(join(workspace, "report.md"), "");
    expect(() => parseResearchReport(finalText, workspace)).toThrow("invalid_report");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report parser classifies raw non-exact paths as unsafe and malformed paths as invalid", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-report-classification-"));
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "report.md"), "# Full report\n", { mode: 0o600 });
    const report = {
      summary: "不可行。",
      feasibility: { verdict: "infeasible", notes: "缺少权限。" },
      evidence: [],
      risks: [],
      unknowns: ["权限未知"],
      reportPath: "report.md",
    };
    for (const reportPath of [" report.md ", "../report.md", "C:\\outside\\report.md"]) {
      expect(researchErrorCode(() => parseResearchReport(
        JSON.stringify({ ...report, reportPath }),
        workspace,
      ))).toBe("unsafe_report_path");
    }
    expect(researchErrorCode(() => parseResearchReport(
      JSON.stringify({ ...report, reportPath: 1 }),
      workspace,
    ))).toBe("invalid_report");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report parser maps malformed evidence sources to invalid_report", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-report-url-"));
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "report.md"), "# Full report\n", { mode: 0o600 });
    let thrown: unknown;
    try {
      parseResearchReport(JSON.stringify({
        summary: "来源无效。",
        feasibility: { verdict: "unknown", notes: "" },
        evidence: [{ claim: "无效来源", source: "not-a-url" }],
        risks: [],
        unknowns: [],
        reportPath: "report.md",
      }), workspace);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResearchError);
    expect(thrown).toMatchObject({ code: "invalid_report", httpStatus: 422 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial output is explicitly incomplete and bounded", () => {
  const text = buildPartialReport("last visible text");
  expect(text).toContain("Status: incomplete");
  expect(text).toContain("last visible text");
  expect(text.length).toBeLessThanOrEqual(65_536);
});

test("partial output is bounded on UTF-8 character boundaries", () => {
  const text = `${"a".repeat(64_998)}😀${"b".repeat(100)}`;
  const output = buildPartialReport(text);
  expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(65_536);
  expect(output).toContain("Status: incomplete");
  expect(output).not.toContain("\uFFFD");
  expect(output).toContain("a".repeat(1_000));
});

test("regular file validation classifies non-directory ancestors as unsafe paths", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-report-parent-file-"));
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "blocked"), "not a directory\n");
    expect(researchErrorCode(() => assertRegularFileInside(
      join(workspace, "blocked", "report.md"),
      workspace,
    ))).toBe("unsafe_report_path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("regular file validation rejects linked ancestors even when their targets stay inside", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-ancestor-link-"));
  try {
    const workspace = join(root, "workspace");
    const actual = join(workspace, "actual");
    const linked = join(workspace, "linked");
    mkdirSync(actual, { recursive: true });
    writeFileSync(join(actual, "report.md"), "# Full report\n", { mode: 0o600 });
    linkDirectory(actual, linked);
    expect(researchErrorCode(() => assertRegularFileInside(
      join(linked, "report.md"),
      workspace,
    ))).toBe("unsafe_report_path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report validation maps unexpected filesystem failures to resource errors", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-report-resource-"));
  const realpath = spyOn(fs, "realpathSync").mockImplementation((() => {
    throw Object.assign(new Error("access denied"), { code: "EACCES" });
  }) as unknown as typeof fs.realpathSync);
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "report.md"), "# Full report\n", { mode: 0o600 });
    expect(researchErrorCode(() => assertRegularFileInside(
      join(workspace, "report.md"),
      workspace,
    ))).toBe("resource_error");
  } finally {
    realpath.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("regular file validation does not follow a symlink outside the workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-link-"));
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const outside = join(root, "outside.md");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(workspace, "report.md"));
    expect(() => assertRegularFileInside(join(workspace, "report.md"), workspace)).toThrow("unsafe_report_path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
