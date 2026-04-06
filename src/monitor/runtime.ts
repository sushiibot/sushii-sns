import { readFileSync } from "fs";
import { join } from "path";

export function isDevMode(): boolean {
  const lifecycle = process.env.npm_lifecycle_event;
  if (lifecycle === "dev") return true;
  if (process.env.MONITOR_DEV_MODE === "1") return true;
  return Bun.argv.includes("--monitor-dev");
}

export function loadMockJson<T>(fileName: string): T {
  const path = join(process.cwd(), "mocks", "monitor", fileName);
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as T;
}
