import { readFileSync } from "node:fs";

import type { StageText } from "../../../shared/types/index.js";
import { buildNasApp } from "./app.js";
import { loadNasConfig } from "./config.js";

async function main(): Promise<void> {
  try {
    const loaded = loadNasConfig(process.env);
    const app = buildNasApp({ config: { ...loaded, stageTextCatalog: loadCatalog(loaded.stageTextCatalogPath) } });
    await app.listen({ host: process.env.NAS_BIND_HOST ?? "127.0.0.1", port: Number(process.env.NAS_PORT ?? "8787") });
  } catch {
    process.stderr.write("NAS record service configuration unavailable\n");
    process.exitCode = 1;
  }
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

void main();
