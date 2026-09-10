import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AIChallengeGame, BattlePopup, ChallengeSummary, createChallengeSaveInput } from "../../apps/typing-game/src/AIChallengeGame";
import { TypingGameApp } from "../../apps/typing-game/src/TypingGameApp";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import { createBootstrapData } from "../../shared/events/bootstrapData";
import { loadEventProfile } from "../../shared/events/eventProfile";

const participant = { name: "합성검증", phone1: "010", phone2: "0000", phone3: "1234", birthYear: "2000", birthMonth: "1", birthDay: "1", privacyAgreedAt: "2026-09-10T00:00:00Z" };
const battle = { stage: 1, text: "로봇과 노는 금천과학축제", userTimeMs: 8400, userCpm: 150, userAccuracy: 100, aiTimeMs: 10000, aiElapsedMs: 8400, aiCpm: 125, plannedAiCpm: 125, aiTypedUnits: 20, aiTypedChars: 10, result: "USER_WIN" as const, userInput: "로봇과 노는 금천과학축제" };
const assetBaseUrl = "file:///assets";

// Catch: a global replacement changes other events or persisted result labels;
// a missing event branch leaves participant terminology in visible game output.
for (const profileId of ["geumcheon-2026", "skillup-2026"]) {
  const eventProfile = loadEventProfile(path.resolve(`events/${profileId}/event.config.json`));
  const geumcheon = profileId === "geumcheon-2026";
  test(`${profileId} main and duel keep the correct event-scoped participant wording`, () => {
    const bootstrap = createBootstrapData({ config: DEFAULT_CONFIG, assetBaseUrl, notices: [], mode: "game", variant: "ai", eventProfile });
    const main = renderToStaticMarkup(createElement(TypingGameApp, { bootstrap }));
    assert.ok(main.includes(`placeholder="${geumcheon ? "도전자" : "참여자"} 이름"`));
    const duel = renderToStaticMarkup(createElement(AIChallengeGame, { config: DEFAULT_CONFIG, participant, stageTexts: [battle.text, battle.text, battle.text], assetBaseUrl, eventProfile, onHome() {}, onRetry() {} }));
    assert.ok(duel.includes(`<h2>${geumcheon ? "도전자" : "참여자"}</h2>`));
  });
  for (const stage of [1, 2, 3]) for (const result of ["USER_WIN", "AI_WIN"] as const) {
    test(`${profileId} stage ${stage} ${result} preserves intermediate copy and scopes record labels`, () => {
      const html = renderToStaticMarkup(createElement(BattlePopup, { battle: { ...battle, stage, result }, isFinalWin: stage === 3 && result === "USER_WIN", onNext() {}, onRetry() {}, onHome() {}, saveError: "", assetBaseUrl, eventProfile, isDebug: false }));
      assert.ok(html.includes(`${geumcheon ? "도전자" : "사용자"} 기록`));
      assert.ok(html.includes(`${geumcheon ? "도전자" : "사용자"}${result === "USER_WIN" ? " 타수" : " 현재 타수"}`));
      assert.doesNotMatch(html, /AI 금나래보다 빠르고 정확하게 완성했습니다/);
      if (geumcheon) {
        assert.ok(html.includes(result === "USER_WIN" ? "승리했습니다.<br/>금나래보다 빠르게 입력했습니다." : "아쉽습니다.<br/>금나래가 먼저 입력을 완료했습니다."));
        assert.doesNotMatch(html, /<p class="eyebrow">Stage/);
      }
    });
  }
  test(`${profileId} summary display does not rewrite the saved result contract`, () => {
    const summary = renderToStaticMarkup(createElement(ChallengeSummary, { battles: [battle], row: null, participant, assetBaseUrl, eventProfile }));
    assert.ok(summary.includes(`<span>${geumcheon ? "도전자" : "참여자"} <strong>`));
    if (geumcheon) assert.match(summary, /도전자 : 8\.40초/);
    else assert.match(summary, /사용자 총 기록/);
    const saved = createChallengeSaveInput({ participant, stageTexts: [battle.text, battle.text, battle.text], stageTextSelections: [
      { id: "synthetic-1", catalogVersion: "synthetic-v1", stageNumber: 1, text: battle.text },
      { id: "synthetic-2", catalogVersion: "synthetic-v1", stageNumber: 2, text: battle.text },
      { id: "synthetic-3", catalogVersion: "synthetic-v1", stageNumber: 3, text: battle.text }
    ], battleRows: [battle, { ...battle, stage: 2 }, { ...battle, stage: 3 }], status: "SUCCESS", failedStage: "", terminalStage: 3, isGeumcheon: geumcheon, debugModeType: "" });
    assert.equal(saved.ai?.display?.resultLabel, "참여자 승리");
    assert.equal(saved.participant_name, participant.name);
  });
}
