import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  type Dirent,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteFile } from "./system";
import {
  RESEARCH_BATCH_ID_PATTERN,
  RESEARCH_TASK_ID_PATTERN,
  ResearchError,
  type ResearchArtifact,
  type ResearchArtifactKind,
  type ResearchBatchRecord,
  type ResearchIdempotencyRecord,
  type ResearchSubmissionRecord,
  type ResearchTaskSnapshot,
} from "./contracts";
import { assertRegularFileInside, buildPartialReport } from "./report";

function assertId(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw unsafeStorePath(`Invalid ${label}`);
}

function unsafeStorePath(message: string): ResearchError {
  return new ResearchError("unsafe_report_path", `unsafe_report_path: ${message}`, 400);
}

function storeResourceError(message: string): ResearchError {
  return new ResearchError("resource_error", `resource_error: ${message}`, 500);
}

function assertStoreContained(resolvedPath: string, realRoot: string): void {
  const rel = relative(realRoot, resolvedPath);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return;
  throw unsafeStorePath("Store path escapes the real research store root");
}

function assertNoLinkedComponents(path: string, realRoot: string): void {
  const resolvedPath = resolve(path);
  assertStoreContained(resolvedPath, realRoot);
  const rel = relative(realRoot, resolvedPath);
  if (rel === "") return;
  let current = realRoot;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (code === "ENOTDIR") throw unsafeStorePath("Store path contains a non-directory component");
      throw storeResourceError("Unable to inspect a store path");
    }
    if (stats.isSymbolicLink()) throw unsafeStorePath("Store path contains a symbolic link or junction");
    let real: string;
    try {
      real = realpathSync(current);
    } catch {
      throw storeResourceError("Unable to resolve a store path");
    }
    assertStoreContained(real, realRoot);
  }
}

const HARDEN_WINDOWS_BATCH = 50;

function hardenWindowsDirectories(paths: string[]): void {
  if (process.platform !== "win32") return;
  const user = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME;
  if (!user) throw storeResourceError("Unable to determine the research store owner");
  for (let start = 0; start < paths.length; start += HARDEN_WINDOWS_BATCH) {
    const batch = paths.slice(start, start + HARDEN_WINDOWS_BATCH);
    const pathVariables = batch.map((_, index) => `$env:CCWEB_STORE_PATH_${index}`);
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$full = [System.Security.AccessControl.FileSystemRights]::FullControl",
      "$inherit = [System.Security.AccessControl.InheritanceFlags]::None",
      "$allow = [System.Security.AccessControl.AccessControlType]::Allow",
      "$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')",
      "$admins = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')",
      "$owner = New-Object System.Security.Principal.NTAccount($env:CCWEB_STORE_OWNER)",
      "$rule = [System.Security.AccessControl.FileSystemAccessRule]",
      "foreach ($path in $paths) {",
      "  $acl = [System.IO.Directory]::GetAccessControl($path)",
      "  $acl.SetAccessRuleProtection($true, $false)",
      "  foreach ($existing in @($acl.Access | Where-Object { -not $_.IsInherited })) {",
      "    $acl.RemoveAccessRuleSpecific($existing) | Out-Null",
      "  }",
      "  foreach ($principal in @($owner, $system, $admins)) {",
      "    $acl.AddAccessRule($rule::new($principal, $full, $inherit, [System.Security.AccessControl.PropagationFlags]::None, $allow))",
      "  }",
      "  [System.IO.Directory]::SetAccessControl($path, $acl)",
      "}",
    ].join("; ");
    const env: NodeJS.ProcessEnv = { ...process.env, CCWEB_STORE_OWNER: user };
    batch.forEach((path, index) => { env[`CCWEB_STORE_PATH_${index}`] = path; });
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$paths = @(${pathVariables.join(",")}); ${script}`], {
      encoding: "utf8",
      windowsHide: true,
      env,
      timeout: 15_000,
    });
    if (result.error || result.status !== 0) {
      const detail = [result.error?.message, result.stderr?.trim()].filter(Boolean).join(" | ").slice(-512);
      throw storeResourceError(`Unable to apply private research store directory permissions${detail ? `: ${detail}` : ""}`);
    }
  }
}

function listTaskTreeDirectories(root: string): string[] {
  const jobsDir = join(root, "jobs");
  let entries: Dirent[];
  try {
    entries = readdirSync(jobsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskRoot = join(jobsDir, entry.name);
    paths.push(taskRoot);
    for (const leaf of ["artifacts", "workspace"]) {
      const leafPath = join(taskRoot, leaf);
      try {
        if (lstatSync(leafPath).isDirectory()) paths.push(leafPath);
      } catch {}
    }
  }
  return paths;
}

function ensureStoreDirectory(path: string, realRoot: string): string {
  assertNoLinkedComponents(path, realRoot);
  let existed = true;
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw unsafeStorePath("Store directory path must be a real directory");
    }
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw storeResourceError("Unable to inspect a store directory");
    }
    if (code === "ENOTDIR") throw unsafeStorePath("Store directory path contains a non-directory component");
    existed = false;
  }
  if (!existed) {
    try {
      // Windows: the parent is hardened with non-inheritable ACEs, so a
      // directory created here receives the creating token's default DACL
      // (owner, SYSTEM, Administrators: FullControl, none inherited) and is
      // private without any child process. Repair sweeps below re-establish
      // explicit DACLs for anything not created by this process.
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } catch {
      throw storeResourceError("Unable to create a store directory");
    }
  }
  if (process.platform !== "win32") {
    try { chmodSync(path, 0o700); } catch {}
  }
  assertNoLinkedComponents(path, realRoot);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    throw storeResourceError("Unable to inspect a store directory");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw unsafeStorePath("Store directory must be a real directory");
  }
  return path;
}

function assertStoreFileTarget(path: string, realRoot: string): string | undefined {
  assertNoLinkedComponents(path, realRoot);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ENOTDIR") throw unsafeStorePath("Store file path contains a non-directory component");
    throw storeResourceError("Unable to inspect a store file");
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw unsafeStorePath("Store file path must be a regular file");
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw storeResourceError("Unable to resolve a store file");
  }
  assertStoreContained(real, realRoot);
  return real;
}

function readStoreBytes(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw storeResourceError("Unable to read a store file");
  }
}

function readStoreJson<T>(path: string, realRoot: string): T | undefined {
  const real = assertStoreFileTarget(path, realRoot);
  if (!real) return undefined;
  try {
    return JSON.parse(readFileSync(real, "utf8")) as T;
  } catch {
    throw storeResourceError("Unable to read a store record");
  }
}

function writeStoreFile(path: string, data: string | Uint8Array, realRoot: string): void {
  assertStoreFileTarget(path, realRoot);
  try {
    atomicWriteFile(path, data);
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw storeResourceError("Unable to atomically persist a store file");
  }
  if (!assertStoreFileTarget(path, realRoot)) {
    throw storeResourceError("Atomically persisted store file is missing");
  }
}

export class ResearchStore {
  readonly root: string;

  constructor(root: string) {
    const requestedRoot = resolve(root);
    try {
      mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
      this.root = realpathSync(requestedRoot);
      if (process.platform !== "win32") chmodSync(this.root, 0o700);
      const jobs = ensureStoreDirectory(join(this.root, "jobs"), this.root);
      const batches = ensureStoreDirectory(join(this.root, "batches"), this.root);
      const idempotency = ensureStoreDirectory(join(this.root, "idempotency"), this.root);
      const submissions = ensureStoreDirectory(join(this.root, "submissions"), this.root);
      hardenWindowsDirectories([this.root, jobs, batches, idempotency, submissions]);
      const nested = listTaskTreeDirectories(this.root);
      if (nested.length > 0) {
        if (process.platform === "win32") hardenWindowsDirectories(nested);
        else {
          for (const path of nested) {
            try { chmodSync(path, 0o700); } catch {}
          }
        }
      }
    } catch (error) {
      if (error instanceof ResearchError) throw error;
      throw storeResourceError("Unable to initialize the research store");
    }
  }

  workspacePath(taskId: string): string {
    assertId(taskId, RESEARCH_TASK_ID_PATTERN, "task id");
    return join(this.root, "jobs", taskId, "workspace");
  }

  private taskRoot(taskId: string): string {
    assertId(taskId, RESEARCH_TASK_ID_PATTERN, "task id");
    return join(this.root, "jobs", taskId);
  }

  saveTask(task: ResearchTaskSnapshot): void {
    const expectedWorkspace = this.workspacePath(task.taskId);
    if (resolve(task.workspacePath) !== resolve(expectedWorkspace)) {
      throw unsafeStorePath(`Task ${task.taskId} has an unexpected workspace path`);
    }
    const taskRoot = ensureStoreDirectory(this.taskRoot(task.taskId), this.root);
    ensureStoreDirectory(join(taskRoot, "artifacts"), this.root);
    ensureStoreDirectory(expectedWorkspace, this.root);
    const statePath = join(taskRoot, "state.json");
    writeStoreFile(statePath, `${JSON.stringify(task, null, 2)}\n`, this.root);
  }

  getTask(taskId: string): ResearchTaskSnapshot | undefined {
    return readStoreJson<ResearchTaskSnapshot>(join(this.taskRoot(taskId), "state.json"), this.root);
  }

  listSubmissions(): ResearchSubmissionRecord[] {
    const submissions = ensureStoreDirectory(join(this.root, "submissions"), this.root);
    let entries: Dirent[];
    try { entries = readdirSync(submissions, { withFileTypes: true }); } catch { throw storeResourceError("Unable to list research submissions"); }
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
      .map(entry => readStoreJson<ResearchSubmissionRecord>(join(submissions, entry.name), this.root))
      .filter((record): record is ResearchSubmissionRecord => record !== undefined)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.batch.batchId.localeCompare(b.batch.batchId));
  }

  getSubmission(batchId: string): ResearchSubmissionRecord | undefined {
    assertId(batchId, RESEARCH_BATCH_ID_PATTERN, "batch id");
    return readStoreJson<ResearchSubmissionRecord>(join(this.root, "submissions", `${batchId}.json`), this.root);
  }

  saveSubmission(record: ResearchSubmissionRecord): void {
    assertId(record.batch.batchId, RESEARCH_BATCH_ID_PATTERN, "batch id");
    ensureStoreDirectory(join(this.root, "submissions"), this.root);
    writeStoreFile(join(this.root, "submissions", `${record.batch.batchId}.json`), `${JSON.stringify(record, null, 2)}\n`, this.root);
  }

  findSubmissionByIdempotency(key: string): ResearchSubmissionRecord | undefined {
    return this.listSubmissions().find(record => record.idempotency?.key === key);
  }

  listTasks(): ResearchTaskSnapshot[] {
    const jobs = ensureStoreDirectory(join(this.root, "jobs"), this.root);
    let entries: Dirent[];
    try {
      entries = readdirSync(jobs, { withFileTypes: true });
    } catch {
      throw storeResourceError("Unable to list research tasks");
    }
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => this.getTask(entry.name))
      .filter((task): task is ResearchTaskSnapshot => task !== undefined)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId));
  }

  saveBatch(batch: ResearchBatchRecord): void {
    assertId(batch.batchId, RESEARCH_BATCH_ID_PATTERN, "batch id");
    ensureStoreDirectory(join(this.root, "batches"), this.root);
    const path = join(this.root, "batches", `${batch.batchId}.json`);
    writeStoreFile(path, `${JSON.stringify(batch, null, 2)}\n`, this.root);
  }

  getBatch(batchId: string): ResearchBatchRecord | undefined {
    assertId(batchId, RESEARCH_BATCH_ID_PATTERN, "batch id");
    return readStoreJson<ResearchBatchRecord>(join(this.root, "batches", `${batchId}.json`), this.root);
  }

  getIdempotency(key: string): ResearchIdempotencyRecord | undefined {
    const digest = createHash("sha256").update(key).digest("hex");
    return readStoreJson<ResearchIdempotencyRecord>(join(this.root, "idempotency", `${digest}.json`), this.root);
  }

  saveIdempotency(record: ResearchIdempotencyRecord): void {
    const digest = createHash("sha256").update(record.key).digest("hex");
    ensureStoreDirectory(join(this.root, "idempotency"), this.root);
    const path = join(this.root, "idempotency", `${digest}.json`);
    writeStoreFile(path, `${JSON.stringify(record, null, 2)}\n`, this.root);
  }

  writePartialText(taskId: string, text: string): void {
    const workspace = ensureStoreDirectory(this.workspacePath(taskId), this.root);
    writeStoreFile(join(workspace, "partial-report.md"), buildPartialReport(text), this.root);
  }

  publishArtifact(task: ResearchTaskSnapshot, kind: ResearchArtifactKind): ResearchArtifact {
    let sourceName: string;
    let destinationName: string;
    switch (kind) {
      case "detailed_report":
        sourceName = "report.md";
        destinationName = "detailed-report.md";
        break;
      case "partial_report":
        sourceName = "partial-report.md";
        destinationName = "partial-report.md";
        break;
      default:
        throw new ResearchError("invalid_report", "invalid_report: Invalid artifact kind", 422);
    }
    const workspace = this.workspacePath(task.taskId);
    const source = assertRegularFileInside(join(workspace, sourceName), workspace);
    const artifacts = join(this.taskRoot(task.taskId), "artifacts");
    ensureStoreDirectory(artifacts, this.root);
    const destination = join(artifacts, destinationName);
    const existingPath = assertStoreFileTarget(destination, this.root);
    const bytes = readStoreBytes(source);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = existingPath ? readStoreBytes(existingPath) : undefined;
    const existingHash = existing ? createHash("sha256").update(existing).digest("hex") : undefined;
    if (existingHash !== sha256) writeStoreFile(destination, bytes, this.root);
    try { chmodSync(destination, 0o600); } catch {}
    return {
      kind,
      path: destination,
      sizeBytes: bytes.byteLength,
      sha256,
      complete: kind === "detailed_report",
    };
  }

  removeArtifact(taskId: string, kind: ResearchArtifactKind): void {
    const destination = kind === "detailed_report" ? "detailed-report.md" : "partial-report.md";
    const path = join(this.taskRoot(taskId), "artifacts", destination);
    const existing = assertStoreFileTarget(path, this.root);
    if (existing) rmSync(existing, { force: true });
  }

  hasPartialReport(taskId: string): boolean {
    const workspace = this.workspacePath(taskId);
    assertNoLinkedComponents(workspace, this.root);
    return assertStoreFileTarget(join(workspace, "partial-report.md"), this.root) !== undefined;
  }
}
