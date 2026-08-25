import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parseStageTextCatalog } from "../../shared/events/stageTextCatalog";
import {
  drawStageTextFromBag,
  stageTextBagKey,
  type StageTextShuffleState
} from "../../shared/utils/stageTextShuffle";

const rows = parseStageTextCatalog(
  fs.readFileSync("events/geumcheon-2026/stage_texts.csv", "utf8")
);
const keyInput = {
  eventId: "geumcheon-science-festival-2026",
  catalogVersion: "geumcheon-draft-20260825-v1",
  sessionKind: "official" as const,
  gameMode: "ai_challenge" as const,
  stageNumber: 1 as const
};

test("does not repeat before a bag is exhausted", () => {
  const stageRows = rows.filter((row) => row.stage_number === "1");
  const key = stageTextBagKey(keyInput);
  let state: StageTextShuffleState = { schemaVersion: 2, bags: {} };
  const drawn: string[] = [];

  for (let index = 0; index < 20; index += 1) {
    const result = drawStageTextFromBag(stageRows, key, state, () => 0.37);
    drawn.push(result.selected.id);
    state = result.nextState;
  }

  assert.equal(new Set(drawn).size, 20);
});

test("does not repeat the final selection immediately after a bag refill", () => {
  const stageRows = rows.filter((row) => row.stage_number === "1");
  const key = stageTextBagKey(keyInput);
  let state: StageTextShuffleState = { schemaVersion: 2, bags: {} };
  let previous = "";

  for (let index = 0; index < 21; index += 1) {
    const result = drawStageTextFromBag(stageRows, key, state, () => 0);
    assert.notEqual(result.selected.id, previous);
    previous = result.selected.id;
    state = result.nextState;
  }
});

test("separates official and practice bags", () => {
  const official = stageTextBagKey(keyInput);
  const practice = stageTextBagKey({ ...keyInput, sessionKind: "practice" });
  const otherStage = stageTextBagKey({ ...keyInput, stageNumber: 2 });

  assert.notEqual(official, practice);
  assert.notEqual(official, otherStage);
  assert.match(official, /geumcheon-science-festival-2026/);
  assert.match(official, /geumcheon-draft-20260825-v1/);
});
