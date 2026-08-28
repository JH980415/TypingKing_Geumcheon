import { parse } from "csv-parse/sync";
import type { StageText } from "../types";

const REQUIRED_HEADERS = [
  "id",
  "catalog_version",
  "game_mode",
  "stage_number",
  "text",
  "is_active",
  "created_at",
  "updated_at"
] as const;
const ALLOWED_TEXT = /^[가-힣ㄱ-ㅎㅏ-ㅣ0-9 !,.~?\r\n]+$/;

export type StageTextCatalogRules = {
  expectedVersion: string;
  expectedMode: "ai_challenge";
  expectedRowsPerStage: number;
};

export function parseStageTextCatalog(csvText: string): StageText[] {
  const rows = parse(csvText, { bom: true, columns: true, skip_empty_lines: true }) as Record<string, unknown>[];
  if (rows.length === 0) throw new Error("Stage text catalog is empty");
  return rows.map((row) => {
    for (const header of REQUIRED_HEADERS) {
      if (typeof row[header] !== "string") throw new Error(`Stage text catalog is missing ${header}`);
    }
    return {
      id: row.id as string,
      catalog_version: row.catalog_version as string,
      game_mode: row.game_mode as string,
      stage_number: row.stage_number as string,
      text: row.text as string,
      is_active: row.is_active as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string
    };
  });
}

export function validateStageTextCatalog(rows: readonly StageText[], rules: StageTextCatalogRules): void {
  const expectedTotal = rules.expectedRowsPerStage * 3;
  if (rows.length !== expectedTotal) throw new Error(`Expected ${expectedTotal} stage text rows`);
  const ids = new Set<string>();
  const texts = new Set<string>();
  for (const row of rows) {
    if (!row.id || ids.has(row.id)) throw new Error("Stage text IDs must be unique");
    if (!row.text.trim() || texts.has(row.text)) throw new Error("Stage text bodies must be unique");
    if (!ALLOWED_TEXT.test(row.text)) throw new Error(`Stage text contains unsupported characters: ${row.id}`);
    if (row.catalog_version !== rules.expectedVersion) throw new Error(`Unexpected catalog version: ${row.id}`);
    if (row.game_mode !== rules.expectedMode) throw new Error(`Unexpected game mode: ${row.id}`);
    if (row.is_active !== "true") throw new Error(`Inactive catalog row: ${row.id}`);
    if (!/^[123]$/.test(row.stage_number)) throw new Error(`Invalid stage number: ${row.id}`);
    ids.add(row.id);
    texts.add(row.text);
  }
  for (const stage of ["1", "2", "3"]) {
    if (rows.filter((row) => row.stage_number === stage).length !== rules.expectedRowsPerStage) {
      throw new Error(`Stage ${stage} must contain ${rules.expectedRowsPerStage} rows`);
    }
  }
}
