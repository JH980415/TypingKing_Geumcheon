import { readFileSync } from "node:fs";

import type { StageText } from "../../../shared/types/index.js";
import { buildNasApp } from "./app.js";
import { loadNasConfig } from "./config.js";

async function main(): Promise<void> {
  try {
    const listenOptions = resolveListenOptions(process.env);
    const loaded = loadNasConfig(process.env);
    const app = buildNasApp({ config: { ...loaded, stageTextCatalog: loadCatalog(loaded.stageTextCatalogPath) } });
    await app.listen(listenOptions);
  } catch {
    process.stderr.write("NAS record service configuration unavailable\n");
    process.exitCode = 1;
  }
}

export function resolveListenOptions(environment: NodeJS.ProcessEnv): { host: "127.0.0.1" | "::1"; port: number } {
  const host = environment.NAS_BIND_HOST ?? "127.0.0.1";
  const rawPort = environment.NAS_PORT;
  if ((host !== "127.0.0.1" && host !== "::1") || (rawPort != null && !/^\d+$/.test(rawPort))) {
    throw new Error("NAS_LISTEN_INVALID");
  }
  const port = rawPort == null ? 8787 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("NAS_LISTEN_INVALID");
  return { host, port };
}

function loadCatalog(path: string): StageText[] {
  const [header, ...rows] = readFileSync(path, "utf8").replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const names = parseCsv(header ?? "");
  const required = ["id", "catalog_version", "game_mode", "stage_number", "text", "is_active", "created_at", "updated_at"];
  if (names.length !== required.length || required.some((name, index) => names[index] !== name)) throw new Error("CATALOG_INVALID");
  return rows.filter(Boolean).map((row) => {
    const values = parseCsv(row);
    if (values.length !== names.length) throw new Error("CATALOG_INVALID");
    return Object.fromEntries(names.map((name, index) => [name, values[index] ?? ""])) as StageText;
  });
}

function parseCsv(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { field += '"'; index += 1; } else quoted = !quoted;
    } else if (character === "," && !quoted) { fields.push(field); field = ""; } else field += character;
  }
  if (quoted) throw new Error("CATALOG_INVALID");
  fields.push(field);
  return fields;
}

if (process.argv[1] != null && /(?:^|[\\/])(?:cli\.ts|server\.cjs)$/.test(process.argv[1])) {
  void main();
}
