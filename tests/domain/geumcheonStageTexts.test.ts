import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadEventProfile } from "../../shared/events/eventProfile";
import {
  parseStageTextCatalog,
  validateStageTextCatalog
} from "../../shared/events/stageTextCatalog";

const catalogVersion = "geumcheon-draft-20260825-v1";
const catalogPath = path.resolve("events/geumcheon-2026/stage_texts.csv");

function catalogRows() {
  return parseStageTextCatalog(fs.readFileSync(catalogPath, "utf8"));
}

test("contains exactly twenty active phrases per Geumcheon AI stage", () => {
  const rows = catalogRows();
  validateStageTextCatalog(rows, {
    expectedVersion: catalogVersion,
    expectedMode: "ai_challenge",
    expectedRowsPerStage: 20
  });
  const countByStage = Object.fromEntries(
    ["1", "2", "3"].map((stage) => [
      stage,
      rows.filter((row) => row.stage_number === stage).length
    ])
  );

  assert.equal(rows.length, 60);
  assert.deepEqual(countByStage, { "1": 20, "2": 20, "3": 20 });
  assert.equal(new Set(rows.map((row) => row.id)).size, 60);
  assert.equal(new Set(rows.map((row) => row.text)).size, 60);
});

test("uses safe Korean-only phrase content and the required sequential IDs", () => {
  const rows = catalogRows();
  const allowed = /^[가-힣ㄱ-ㅎㅏ-ㅣ0-9 !,.~?\r\n]+$/;
  const expectedIds = [1, 2, 3].flatMap((stage) =>
    Array.from({ length: 20 }, (_value, index) => `gsc26-ai-s${stage}-${String(index + 1).padStart(3, "0")}`)
  );

  assert.deepEqual(rows.map((row) => row.id), expectedIds);
  for (const row of rows) {
    assert.match(row.text, allowed);
    assert.ok(row.text.trim().length > 0);
    assert.equal(row.catalog_version, catalogVersion);
    assert.equal(row.game_mode, "ai_challenge");
    assert.equal(row.is_active, "true");
  }
});

test("keeps event profile and catalog version in lockstep", () => {
  const profile = loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json"));
  const rows = catalogRows();

  assert.equal(profile.stageTextCatalogVersion, catalogVersion);
  assert.ok(rows.every((row) => row.catalog_version === profile.stageTextCatalogVersion));
});
