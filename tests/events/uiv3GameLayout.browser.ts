import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { chromium, type Page } from "playwright-core";
import { createServer } from "vite";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import { createBootstrapData } from "../../shared/events/bootstrapData";
import { loadEventProfile } from "../../shared/events/eventProfile";
import { buildRecordRow } from "../../shared/csv/fileStore";

const baseline = JSON.parse(fs.readFileSync("Codex/Evidence/UIV3_20260910/BEFORE_FIXED_GEOMETRY.json", "utf8"));
const stageTexts = ["로봇과 노는 금천과학축제", "인공지능 로봇의 신나는 축제!", "AI와 소통하는 활기찬 미래 금천"];
const stageTextSelections = stageTexts.map((text, index) => ({ id: `gsc26-ai-s${index + 1}-001`, catalogVersion: "geumcheon-r5-20260903-v1", stageNumber: index + 1, text }));
const participant = { name: "합성검증", phone1: "010", phone2: "0000", phone3: "1234", birthYear: "2000", birthMonth: "1", birthDay: "1", privacyAgreedAt: "2026-09-10T00:00:00Z" };
const mainSelectors = [".hero-panel", ".geumcheon-main-title-image", ".hero-copy", ".geumcheon-main-robot", ".hero-guide-card", ".hero-guide-list", ".entry-panel", ".entry-form-group", ".entry-form-group .field", ".entry-panel > .button-row", ".entry-panel .primary-button", ".entry-panel .secondary-button"];
const duelSelectors = [".challenge-layout", ".duel-panel:first-child", ".duel-panel:last-child", ".duel-panel:first-child .duel-panel-header", ".duel-panel:first-child .duel-target", ".duel-panel:first-child .duel-input-layer", ".duel-panel:first-child .duel-progress", ".duel-panel:first-child .duel-metrics", ...[1, 2, 3].map(i => `.duel-panel:first-child .duel-metrics > :nth-child(${i})`)];

async function measure(page: Page, selectors: string[]) {
  return page.evaluate((selectors) => Object.fromEntries(selectors.map(selector => {
    const element = document.querySelector(selector)!;
    const style = getComputedStyle(element);
    return [selector, { ...element.getBoundingClientRect().toJSON(), fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight), letterSpacing: parseFloat(style.letterSpacing) || 0, borderBottom: parseFloat(style.borderBottomWidth), borderTop: parseFloat(style.borderTopWidth), textAlign: style.textAlign }];
  })), selectors);
}

// Catch: an enlarged slogan or a new image's intrinsic ratio reflows the fixed
// form/hero slots; moving the guide through flex margin changes the duel cards.
test("UI v3 real game preserves frozen boxes, consent semantics and final-only copy at both sizes", { timeout: 120_000 }, async (t) => {
  const output = fs.mkdtempSync(path.resolve("Codex/Evidence/UIV3_20260910/game-browser-"));
  const server = await createServer({ configFile: false, root: process.cwd(), esbuild: { jsx: "automatic" }, cacheDir: path.join(output, "vite-cache"), server: { host: "127.0.0.1", port: 0, open: false, watch: null }, clearScreen: false,
    plugins: [{ name: "uiv3-game-fixture", configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    if (req.url !== "/__uiv3-duel") return next();
    res.setHeader("Content-Type", "text/html");
    res.end(await vite.transformIndexHtml(req.url, `<!doctype html><html><head></head><body><main id="fixture" class="app game-app"></main><script type="module">
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {AIChallengeGame} from '/apps/typing-game/src/AIChallengeGame.tsx';
      import '/apps/shell/src/styles.css'; import '/apps/typing-game/src/r7-geumcheon.css';
      document.documentElement.dataset.eventProfile=window.__fixture.eventProfile.profileId;
      createRoot(document.getElementById('fixture')).render(React.createElement(AIChallengeGame,{...window.__fixture,onHome(){},onRetry(){}}));
    </script></body></html>`));
  }); } }] });
  const failures: string[] = [], observations: unknown[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const compare = (label: string, actual: any, expected: any, selectors: string[]) => {
    for (const selector of selectors) for (const key of ["x", "y", "width", "height"]) {
      if (!expected[selector]) continue;
      check(Math.abs(actual[selector][key] - expected[selector][key]) <= 2, `${label} ${selector} ${key}: ${actual[selector][key]} != ${expected[selector][key]}`);
    }
  };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer!.address(); assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "msedge", headless: true });
    for (const [width, height] of [[1280, 720], [1920, 1080]]) {
      for (const profileId of ["geumcheon-2026", "skillup-2026"]) {
        const eventProfile = loadEventProfile(path.resolve(`events/${profileId}/event.config.json`));
        const bootstrap = createBootstrapData({ config: DEFAULT_CONFIG, assetBaseUrl: `${origin}/assets`, notices: [], mode: "game", variant: "ai", eventProfile });
        // The same phrase on another line must survive U05; requiredness stays real.
        const rawConsent = bootstrap.config.privacyConsentText + "\n참고: 보존, 경품 지급 및 본인 확인";
        bootstrap.config.privacyConsentText = rawConsent;
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
        await page.addInitScript({ content: `window.typingKing={getBootstrap:async()=>({ok:true,data:${JSON.stringify(bootstrap)}}),getOneDriveSettings:async()=>({ok:true,data:${JSON.stringify(bootstrap.config)}})};` });
        await page.goto(origin); await page.locator(".entry-panel").waitFor();
        await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
        await page.evaluate(() => document.fonts.ready);
        const geumcheon = profileId === "geumcheon-2026";
        check(await page.locator(".entry-form-group .field input").first().getAttribute("placeholder") === (geumcheon ? "도전자 이름" : "참여자 이름"), `${width} ${profileId} placeholder`);
        let initial: any;
        if (geumcheon) {
          initial = await measure(page, mainSelectors);
          const before = baseline.frames.find((f: any) => f.name === "main" && f.viewport[0] === width).rects;
          compare(`${width} main frozen`, initial, before, mainSelectors);
          const copy = await measure(page, [".entry-event-copy", ".entry-event-copy strong", ".entry-event-copy span"]);
          const group = copy[".entry-event-copy"], panel = initial[".entry-panel"], label = initial[".entry-form-group .field"];
          for (const selector of [".entry-event-copy strong", ".entry-event-copy span"]) {
            const line = copy[selector], target = width === 1280 ? 24.128 : 32.5;
            check(Math.abs(line.fontSize - target) <= .01, `${width} ${selector} font ${line.fontSize} expected ${target}`);
            check(Math.abs(line.lineHeight / line.fontSize - 1.25) <= .001, `${width} line-height`);
            check(Math.abs(line.letterSpacing - target * .02) <= .001, `${width} letter spacing`);
            check(Math.abs(line.x + line.width / 2 - panel.x - panel.width / 2) <= 2, `${width} line center X`);
          }
          const top = panel.y + panel.borderTop;
          check(Math.abs(group.y + group.height / 2 - (top + label.y) / 2) <= 2, `${width} slogan center Y`);
          check(group.y - top >= 12 && label.y - group.bottom >= 12, `${width} slogan clearance`);
          observations.push({ width, profileId, main: initial, copy });
          await page.screenshot({ path: path.join(output, `${width}-main.png`) });
        }
        await page.getByRole("button", { name: "동의 내용 보기", exact: true }).click();
        const displayed = await page.locator(".privacy-text").innerText();
        check(displayed === (geumcheon ? rawConsent.replace("이용 목적: 행사 참여 확인, 리더보드 운영, 경품 지급 및 본인 확인", "이용 목적: 행사 참여 확인, 리더보드 운영") : rawConsent), `${width} ${profileId} exact consent delta`);
        await page.getByRole("button", { name: "확인", exact: true }).click();
        await page.locator(".entry-form-group .field input").first().fill("합성검증");
        await page.locator(".phone-row input").nth(0).fill("0000"); await page.locator(".phone-row input").nth(1).fill("1234");
        for (const [i, value] of ["2000", "1", "1"].entries()) await page.locator(".birth-row select").nth(i).selectOption(value);
        check(await page.getByRole("button", { name: "시작", exact: true }).isDisabled(), `${width} ${profileId} consent remains required`);
        if (geumcheon) compare(`${width} error form`, await measure(page, mainSelectors), initial, mainSelectors);
        await page.locator(".check-line input").check();
        check(await page.getByRole("button", { name: "시작", exact: true }).isEnabled(), `${width} ${profileId} consent permits start`);
        if (geumcheon) compare(`${width} valid form`, await measure(page, mainSelectors), initial, mainSelectors);
        check(errors.length === 0, `${width} main runtime errors ${errors.join(",")}`);
        await page.close();
        const duel = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        const saved = buildRecordRow({ participant_name: participant.name, phone_part1: "010", phone_part2: "0000", phone_part3: "1234", birth_year: "2000", birth_month: "1", birth_day: "1", privacy_agreed: true, privacy_agreed_at: participant.privacyAgreedAt, stageTexts: stageTexts as [string, string, string], stageTimesMs: [1000, 1000, 1000], game_mode: "ai_challenge", final_accuracy: 100 });
        await duel.addInitScript({ content: `window.__fixture=${JSON.stringify({ config: { ...bootstrap.config, aiChallenge: { ...bootstrap.config.aiChallenge, countdownSeconds: 1 } }, participant, stageTexts, stageTextSelections, assetBaseUrl: `${origin}/assets`, eventProfile })}; window.typingKing={saveRecord:async(input)=>{window.__saved=input;return {ok:true,data:${JSON.stringify(saved)}}}};` });
        const duelErrors: string[] = []; duel.on("pageerror", error => duelErrors.push(error.message));
        await duel.goto(`${origin}/__uiv3-duel`);
        try { await duel.locator(".challenge-input").waitFor({ timeout: 10_000 }); }
        catch (error) { throw new Error(`${String(error)}; renderer errors: ${duelErrors.join(";")}; body: ${await duel.locator("body").innerText()}`); }
        for (const stage of [1, 2, 3]) {
          await duel.waitForFunction(() => !(document.querySelector(".challenge-input") as HTMLTextAreaElement)?.disabled);
          await duel.waitForFunction(() => !document.querySelector(".countdown-overlay"));
          if (geumcheon) {
            const rects = await measure(duel, [...duelSelectors, ".challenge-guide"]);
            const before = baseline.frames.find((f: any) => f.name === `gameplay-stage-${stage}` && f.viewport[0] === width).rects;
            compare(`${width} stage${stage}`, rects, before, duelSelectors);
            const left = rects[".duel-panel:first-child"], right = rects[".duel-panel:last-child"], cards = rects[".duel-panel:first-child .duel-metrics"], guide = rects[".challenge-guide"];
            check(left.bottom - left.borderBottom - cards.bottom >= 12, `${width} stage${stage} card clearance`);
            check(guide.y - Math.max(left.bottom, right.bottom) >= 12, `${width} stage${stage} guide clearance ${guide.y - Math.max(left.bottom, right.bottom)}`);
            check(height - guide.bottom >= 12, `${width} stage${stage} content edge clearance`);
            check(Math.abs(guide.y - before[".challenge-guide"].y - 4) <= .1, `${width} stage${stage} guide translates exactly 4px`);
            check(await duel.locator(".challenge-guide").innerText() === "문장 전체가 100% 일치하면 자동으로 완료됩니다.\n금나래보다 먼저 완성하세요.", `${width} stage${stage} guide copy`);
            observations.push({ width, profileId, stage, rects });
            await duel.screenshot({ path: path.join(output, `${width}-stage${stage}.png`) });
          }
          if (stage === 1) {
            for (const button of ["다시하기", "메인으로 가기"]) {
              await duel.getByRole("button", { name: button, exact: true }).click();
              check((await duel.locator(".game-confirm-modal p").first().innerText()).includes(`${geumcheon ? "도전자" : "참여자"} 패배 기록`), `${width} ${profileId} ${button} visible wording`);
              await duel.getByRole("button", { name: "취소", exact: true }).click();
            }
          }
          await duel.locator(".challenge-input").fill(stageTexts[stage - 1]);
          try { await duel.locator(".challenge-modal").waitFor({ timeout: 10_000 }); }
          catch (error) { throw new Error(`${width} ${profileId} stage${stage} ${String(error)}; ${duelErrors.join(";")}; ${await duel.locator("body").innerText()}`); }
          if (geumcheon) check(await duel.locator(".challenge-modal-message h2").innerText() === "승리했습니다.\n금나래보다 빠르게 입력했습니다.", `${width} stage${stage} intermediate unchanged`);
          await duel.getByRole("button", { name: stage === 3 ? "최종 결과 보기" : "다음 스테이지", exact: true }).click();
        }
        await duel.locator(".challenge-result-panel").waitFor();
        const heading = await duel.locator(".challenge-result-panel h1").innerText();
        check(heading === (geumcheon ? "도전자 승리.\nAI 금나래보다 빠르고 정확하게 완성했습니다." : "참여자 승리. 금나래보다 빠르고 정확하게 완주했습니다."), `${width} ${profileId} final-only heading ${heading}`);
        check((await duel.evaluate(() => (window as any).__saved)).ai.display.resultLabel === "참여자 승리", `${width} ${profileId} saved result contract`);
        check(duelErrors.length === 0, `${width} duel runtime errors ${duelErrors.join(",")}`);
        if (geumcheon) await duel.screenshot({ path: path.join(output, `${width}-final.png`) });
        await duel.close();
      }
    }
  } finally {
    await browser?.close(); await server.close();
    fs.writeFileSync(path.join(output, "geometry.json"), JSON.stringify({ method: "Real source React in headless Edge; Electron IPC save/read boundary fixtures; not EXE, NAS or native IME/F11 proof", observations, failures }, null, 2));
    t.diagnostic(output);
  }
  assert.deepEqual(failures, []);
});
