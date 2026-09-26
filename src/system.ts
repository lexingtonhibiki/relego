import { chmodSync, mkdirSync, openSync, closeSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

export function getConfigDir(): string {
  const configured = process.env.RESEARCH_GATEWAY_HOME?.trim();
  return resolve(expandUserPath(configured || join(homedir(), ".relego")));
}

const atomicWaitCell = new Int32Array(new SharedArrayBuffer(4));
const WINDOWS_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 150, 250, 350, 500] as const;

function renameAtomicFile(source: string, destination: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transientWindowsError = process.platform === "win32"
        && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (!transientWindowsError || delay === undefined) throw error;
      Atomics.wait(atomicWaitCell, 0, 0, delay);
    }
  }
}

export function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  { mode = 0o600, protectDirectory = true }: { mode?: number; protectDirectory?: boolean } = {},
): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (protectDirectory) {
    try { chmodSync(directory, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
  }
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(temp, "wx", mode);
  try {
    writeFileSync(fd, data);
    closeSync(fd);
    renameAtomicFile(temp, path);
  } catch (error) {
    try { closeSync(fd); } catch {}
    rmSync(temp, { force: true });
    throw error;
  }
  try { chmodSync(path, mode); } catch { /* Windows ACLs are managed by the installer. */ }
}

export function stripUtf8Bom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}
