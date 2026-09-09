import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import postcss from "postcss";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright-core";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AIChallengeGame, BattlePopup } from "../../apps/typing-game/src/AIChallengeGame";
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

// This catches a too-small parent gap after the current badge's 1.05 scale.
// It renders the real component, images and complete CSS, not a CSS-value model.
test("all six popup captions clear the painted badge by 16px and fit both viewport sizes", async (context) => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.R7_HEADLESS_EXECUTABLE ? { executablePath: process.env.R7_HEADLESS_EXECUTABLE } : { channel: "msedge" })
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    const css = ["apps/shell/src/styles.css", "apps/typing-game/src/r7-geumcheon.css"]
      .map(file => fs.readFileSync(file, "utf8")).join("\n");
    const eventProfile = loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json"));
    const observations: Array<Record<string, unknown>> = [];
    const failures: string[] = [];
    const evidence = process.env.R7_POPUP_EVIDENCE;
    if (evidence) fs.mkdirSync(evidence, { recursive: true });
    for (const [width, height] of [[1280, 720], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      for (const stage of [1, 2, 3]) for (const result of ["USER_WIN", "AI_WIN"] as const) {
        const markup = renderToStaticMarkup(createElement(BattlePopup, {
          battle: { stage, text: "로봇과 노는 금천과학축제", userTimeMs: 8400, userCpm: 150.25, userAccuracy: 100,
            aiTimeMs: 10000, aiElapsedMs: 8400, aiCpm: 125, plannedAiCpm: 125, aiTypedUnits: 20, aiTypedChars: 10,
            result, userInput: "로봇과 노는 금천과학축제" },
          isFinalWin: stage === 3 && result === "USER_WIN", onNext() {}, onRetry() {}, onHome() {},
          saveError: "", assetBaseUrl: pathToFileURL(path.resolve("assets")).href, eventProfile, isDebug: false
        })).replace(/<link[^>]*>/g, "").replace(/src="([^"]+)"/g, (_match, source: string) =>
          'src="data:image/png;base64,' + fs.readFileSync(fileURLToPath(source)).toString("base64") + '"');
        await page.setContent('<!doctype html><html data-event-profile="geumcheon-2026"><head><style>' + css +
          '</style></head><body><main class="app game-app">' + markup + '</main></body></html>');
        await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
        await page.evaluate(() => document.fonts.ready);
        const measured = await page.evaluate(() => {
          const heading = document.querySelector(".challenge-modal-message h2") as HTMLElement;
          const badge = document.querySelector(".challenge-modal-message .compact-badges")!;
          const modal = document.querySelector(".challenge-modal")!;
          const bounds = heading.getBoundingClientRect();
          const paintedBottom = Math.max(badge.getBoundingClientRect().bottom,
            ...[...badge.querySelectorAll("*")].map(element => element.getBoundingClientRect().bottom));
          const lineTops: number[] = [];
          const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            if (!walker.currentNode.textContent?.trim()) continue;
            const range = document.createRange(); range.selectNodeContents(walker.currentNode);
            lineTops.push(...[...range.getClientRects()].map(rect => Math.round(rect.top)));
          }
          return { gap: bounds.top - paintedBottom, paintedBottom, heading: bounds.toJSON(),
            text: heading.innerText, align: getComputedStyle(heading).textAlign, lineCount: new Set(lineTops).size,
            modal: modal.getBoundingClientRect().toJSON(), scrollHeight: modal.scrollHeight, clientHeight: modal.clientHeight };
        });
        const label = width + "x" + height + "-stage" + stage + "-" + result;
        observations.push({ label, ...measured });
        if (measured.gap < 16) failures.push(label + " painted gap " + measured.gap.toFixed(3) + "px < 16px");
        const expected = result === "USER_WIN" ? "승리했습니다.\n금나래보다 빠르게 입력했습니다." : "아쉽습니다.\n금나래가 먼저 입력을 완료했습니다.";
        if (measured.text !== expected || measured.lineCount !== 2 || measured.align !== "left") failures.push(label + " caption layout changed");
        if (measured.scrollHeight > measured.clientHeight + 1 || measured.modal.top < 0 || measured.modal.bottom > height + 1
          || measured.heading.bottom > measured.modal.bottom || measured.heading.right > measured.modal.right) failures.push(label + " overflow");
        if (evidence) await page.screenshot({ path: path.join(evidence, label + ".png") });
      }
    }
    if (evidence) fs.writeFileSync(path.join(evidence, "geometry.json"), JSON.stringify({
      method: "Headless Chromium rendering of real SSR BattlePopup + original images + full source CSS; not an EXE or IME test",
      browserVersion: browser.version(), observations, failures
    }, null, 2) + "\n");
    context.diagnostic(JSON.stringify(observations.map(({ label, gap, scrollHeight, clientHeight }) => ({ label, gap, scrollHeight, clientHeight }))));
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
});
