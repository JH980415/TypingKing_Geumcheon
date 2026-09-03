import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drawGeumcheonStageTexts, type RuntimeContext } from "../../shared/csv/fileStore";
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
  catalogVersion: "geumcheon-r5-20260903-v1",
  sessionKind: "official" as const,
  gameMode: "ai_challenge" as const,
  stageNumber: 1 as const
};

test("Stage 1 selects only its two R5 candidates before a bag is exhausted", () => {
  const stageRows = rows.filter((row) => row.stage_number === "1");
  const key = stageTextBagKey(keyInput);
  let state: StageTextShuffleState = { schemaVersion: 2, bags: {} };
  const drawn: string[] = [];

  for (let index = 0; index < 2; index += 1) {
    const result = drawStageTextFromBag(stageRows, key, state, () => 0.37);
    drawn.push(result.selected.id);
    state = result.nextState;
  }

  assert.deepEqual(new Set(drawn), new Set(["gsc26-ai-s1-001", "gsc26-ai-s1-002"]));
});

test("Stage 1 can select the other candidate on a new attempt", () => {
  const stageRows = rows.filter((row) => row.stage_number === "1");
  const key = stageTextBagKey(keyInput);
  let state: StageTextShuffleState = { schemaVersion: 2, bags: {} };
  let previous = "";

  for (let index = 0; index < 3; index += 1) {
    const result = drawStageTextFromBag(stageRows, key, state, () => 0);
    if (previous) assert.notEqual(result.selected.id, previous);
    previous = result.selected.id;
    state = result.nextState;
  }
});

test("real Geumcheon player draws accept 2/2/1 and reject a wrong stage count", () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-stage-draw-"));
  const malformedCatalogPath = path.join(runtimeRoot, "stage_texts-malformed.csv");
  try {
    const input = {
      eventId: "geumcheon-science-festival-2026",
      catalogVersion: "geumcheon-r5-20260903-v1",
      catalogPath: path.resolve("events/geumcheon-2026/stage_texts.csv"),
      sessionKind: "official" as const,
      gameMode: "ai_challenge" as const,
      role: "player" as const
    };
    const draw = drawGeumcheonStageTexts({ paths: { root: runtimeRoot } } as RuntimeContext, input);
    assert.deepEqual(draw.selections.map((selection) => selection.stageNumber), [1, 2, 3]);
    assert.ok(["로봇과 노는 금천과학축제", "인공지능과 함께하는 축제"].includes(draw.selections[0]!.text));
    assert.ok(["인공지능 로봇의 신나는 축제!", "AI야, 금천과학축제 놀러가자!"].includes(draw.selections[1]!.text));
    assert.equal(draw.selections[2]!.text, "AI와 소통하는 활기찬 미래 금천");

    fs.writeFileSync(
      malformedCatalogPath,
      fs.readFileSync(input.catalogPath, "utf8").replace(/^.*gsc26-ai-s2-002.*\r?\n/m, ""),
      "utf8"
    );
    assert.throws(
      () => drawGeumcheonStageTexts({ paths: { root: runtimeRoot } } as RuntimeContext, { ...input, catalogPath: malformedCatalogPath }),
      /Geumcheon stage 2 requires exactly 2 active rows/
    );

    fs.writeFileSync(
      malformedCatalogPath,
      fs.readFileSync(input.catalogPath, "utf8").replace("인공지능 로봇의 신나는 축제!", "인공지능 로봇의 신나는  축제!"),
      "utf8"
    );
    assert.throws(
      () => drawGeumcheonStageTexts({ paths: { root: runtimeRoot } } as RuntimeContext, { ...input, catalogPath: malformedCatalogPath }),
      /Unexpected Geumcheon stage text:/
    );
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("separates official and practice bags", () => {
  const official = stageTextBagKey(keyInput);
  const practice = stageTextBagKey({ ...keyInput, sessionKind: "practice" });
  const otherStage = stageTextBagKey({ ...keyInput, stageNumber: 2 });

  assert.notEqual(official, practice);
  assert.notEqual(official, otherStage);
  assert.match(official, /geumcheon-science-festival-2026/);
  assert.match(official, /geumcheon-r5-20260903-v1/);
});

test("rejects leaderboard draws before it can persist a shuffle bag", () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-stage-draw-"));
  try {
    assert.throws(
      () =>
        drawGeumcheonStageTexts(
          { paths: { root: runtimeRoot } } as RuntimeContext,
          {
            eventId: "geumcheon-science-festival-2026",
            catalogVersion: "geumcheon-r5-20260903-v1",
            catalogPath: path.resolve("events/geumcheon-2026/stage_texts.csv"),
            sessionKind: "official",
            gameMode: "ai_challenge",
            role: "leaderboard"
          }
        ),
      /player/
    );
    assert.equal(fs.existsSync(path.join(runtimeRoot, "state", "stage-text-shuffle.json")), false);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
