import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadEventProfile } from "../../shared/events/eventProfile";
import {
  parseStageTextCatalog
} from "../../shared/events/stageTextCatalog";

const catalogVersion = "geumcheon-r5-20260903-v1";
const catalogPath = path.resolve("events/geumcheon-2026/stage_texts.csv");

function catalogRows() {
  return parseStageTextCatalog(fs.readFileSync(catalogPath, "utf8"));
}

test("contains the exact R5 Geumcheon AI stage catalog", () => {
  const rows = catalogRows();
  const countByStage = Object.fromEntries(
    ["1", "2", "3"].map((stage) => [
      stage,
      rows.filter((row) => row.stage_number === stage).length
    ])
  );

  assert.equal(rows.length, 5);
  assert.deepEqual(countByStage, { "1": 2, "2": 2, "3": 1 });
  assert.deepEqual(rows.map((row) => [row.stage_number, row.text]), [
    ["1", "로봇과 노는 금천과학축제"],
    ["1", "인공지능과 함께하는 축제"],
    ["2", "인공지능 로봇의 신나는 축제!"],
    ["2", "AI야, 금천과학축제 놀러가자!"],
    ["3", "AI와 소통하는 활기찬 미래 금천"]
  ]);
  assert.equal(new Set(rows.map((row) => row.id)).size, 5);
  assert.equal(new Set(rows.map((row) => row.text)).size, 5);
});

test("uses safe content and the required R5 IDs", () => {
  const rows = catalogRows();
  const allowed = /^[가-힣ㄱ-ㅎㅏ-ㅣA-Z0-9 !,.~?\r\n]+$/;
  const expectedIds = ["gsc26-ai-s1-001", "gsc26-ai-s1-002", "gsc26-ai-s2-001", "gsc26-ai-s2-002", "gsc26-ai-s3-001"];

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
