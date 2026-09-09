import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BattlePopup, ChallengeSummary, AIChallengeGame } from "../../apps/typing-game/src/AIChallengeGame";
import { TypingGameApp } from "../../apps/typing-game/src/TypingGameApp";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import { createBootstrapData } from "../../shared/events/bootstrapData";
import { loadEventProfile } from "../../shared/events/eventProfile";

const eventProfile = loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json"));
const participant = { name: "검증 참여자", phone1: "010", phone2: "1234", phone3: "5678", birthYear: "2014", birthMonth: "1", birthDay: "2", privacyAgreedAt: "2026-09-09T00:00:00Z" };
const assetBaseUrl = "file:///resources/assets";
const battle = { stage: 1, text: "1234567890", userTimeMs: 8400, userCpm: 71.43, userAccuracy: 100, aiTimeMs: 10000, aiElapsedMs: 8400, aiCpm: 42.86, plannedAiCpm: 100, aiTypedUnits: 6, aiTypedChars: 6, result: "USER_WIN" as const, userInput: "1234567890" };

test("main guidance renders the approved two lines", () => {
  const bootstrap = createBootstrapData({ config: DEFAULT_CONFIG, assetBaseUrl, notices: [], mode: "game", variant: "ai", eventProfile });
  const html = renderToStaticMarkup(createElement(TypingGameApp, { bootstrap }));
  assert.match(html, /3개의 스테이지에서 금나래보다<br\/>먼저 정확하게 입력하세요\./);
  assert.match(html, /<div class="entry-event-copy"><strong>2026 G-Science Festival<\/strong><span>AI와 소통하는 활기찬 미래 금천<\/span>/);
});

test("other events retain their popup captions, logo and original result summary", () => {
  const otherProfile = loadEventProfile(path.resolve("events/skillup-2026/event.config.json"));
  const popup = renderToStaticMarkup(createElement(BattlePopup, { battle, isFinalWin: false, onNext() {}, onRetry() {}, onHome() {}, saveError: "", assetBaseUrl, eventProfile: otherProfile, isDebug: false }));
  assert.match(popup, /<p class="eyebrow">Stage 1<\/p>/);
  assert.match(popup, /사용자 기록/);
  assert.doesNotMatch(popup, /승리했습니다\.<br\/>/);
  const summary = renderToStaticMarkup(createElement(ChallengeSummary, { battles: [battle], row: null, participant, assetBaseUrl, eventProfile: otherProfile }));
  assert.match(summary, /사용자 총 기록/);
  assert.match(summary, /사용자 최종 타수/);
  assert.doesNotMatch(summary, /r7-victory-summary/);
  const duel = renderToStaticMarkup(createElement(AIChallengeGame, { config: DEFAULT_CONFIG, participant, stageTexts: ["123", "456", "789"], assetBaseUrl, eventProfile: otherProfile, onHome() {}, onRetry() {} }));
  assert.match(duel, /class="challenge-title-image"/);
});

test("duel retains stage identity and gives two-line guidance without the small logo", () => {
  const html = renderToStaticMarkup(createElement(AIChallengeGame, { config: DEFAULT_CONFIG, participant, stageTexts: ["123", "456", "789"], assetBaseUrl, eventProfile, debugModeType: "", onHome() {}, onRetry() {} }));
  assert.doesNotMatch(html, /class="challenge-title-image"/);
  assert.match(html, /문장 전체가 100% 일치하면 자동으로 완료됩니다\.<br\/>금나래보다 먼저 완성하세요\./);
  assert.match(html, /alt="Stage 1"/);
});

for (const stage of [1, 2, 3]) for (const result of ["USER_WIN", "AI_WIN"] as const) {
  test(`stage ${stage} ${result} keeps accessible badges without redundant stage caption`, () => {
    const html = renderToStaticMarkup(createElement(BattlePopup, { battle: { ...battle, stage, result }, isFinalWin: stage === 3 && result === "USER_WIN", onNext() {}, onRetry() {}, onHome() {}, saveError: "", assetBaseUrl, eventProfile, isDebug: false }));
    assert.doesNotMatch(html, /<p class="eyebrow">Stage [123]<\/p>/);
    assert.match(html, new RegExp(`alt="Stage ${stage}"`));
    assert.match(html, /참여자 기록/);
    assert.doesNotMatch(html, /사용자/);
    if (result === "USER_WIN") assert.match(html, /승리했습니다\.<br\/>금나래보다 빠르게 입력했습니다\./);
    else assert.match(html, /아쉽습니다\. 금나래가 먼저 입력을 완료했습니다\./);
  });
}

test("victory cards display each stage's actual participant and AI metrics and retain masked identity", () => {
  const html = renderToStaticMarkup(createElement(ChallengeSummary, { battles: [battle, { ...battle, stage: 2, userTimeMs: 12000, userCpm: 50, aiElapsedMs: 12000, aiCpm: 35, aiTypedChars: 7 }], row: null, participant, assetBaseUrl, eventProfile }));
  assert.match(html, /참여자 : 8\.40초｜10글자｜71\.43타/);
  assert.match(html, /금나래 : 8\.40초｜6글자｜42\.86타/);
  assert.match(html, /참여자 : 12\.00초｜10글자｜50타/);
  assert.match(html, /금나래 : 12\.00초｜7글자｜35타/);
  assert.match(html, /010-\*\*\*\*-5678/);
  assert.doesNotMatch(html, /총 기록|최종 타수|최종 시간 차이/);
});
