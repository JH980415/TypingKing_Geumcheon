import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import postcss from "postcss";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AIChallengeGame } from "../../apps/typing-game/src/AIChallengeGame";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import { loadEventProfile } from "../../shared/events/eventProfile";

test("Geumcheon target has no simulated caret while its native input remains mounted", () => {
  const html = renderToStaticMarkup(createElement(AIChallengeGame, {
    config: DEFAULT_CONFIG, participant: { name: "검증", phone1: "010", phone2: "0000", phone3: "1234", birthYear: "2000", birthMonth: "1", birthDay: "1", privacyAgreedAt: "2026-09-09T00:00:00Z" },
    stageTexts: ["금천 과학", "타자 대결", "마지막"], assetBaseUrl: "file:///assets",
    eventProfile: loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json")), onHome() {}, onRetry() {}
  }));
  assert.doesNotMatch(html, /typing-cursor-anchor/);
  assert.match(html, /<textarea[^>]*class="typing-input challenge-input layered-input"/);
  assert.match(html, /class="pending"/);
});

test("popup flow reserves the full square badge height and separate heading gap", () => {
  const stylesheet = postcss.parse(fs.readFileSync("apps/typing-game/src/r7-geumcheon.css", "utf8"));
  const read = (suffix: string) => {
    const declarations: Record<string, string> = {};
    stylesheet.walkRules(`html[data-event-profile="geumcheon-2026"] .game-app ${suffix}`, (rule) => {
      rule.walkDecls((decl) => { declarations[decl.prop] = decl.value; });
    });
    return declarations;
  };
  const flow = read(".challenge-modal-message");
  assert.equal(flow.display, "flex");
  assert.equal(flow["flex-direction"], "column");
  assert.ok(Number.parseFloat(flow.gap) >= 16);
  const slot = read(".challenge-modal-message .stage-badge.compact");
  assert.equal(slot.height, "84px", "reserve the existing 84px square artwork instead of overflowing the 60px slot");
  assert.equal(slot.width, undefined, "preserve original badge width");
  assert.equal(slot.transform, undefined, "do not shrink badge art");
});
