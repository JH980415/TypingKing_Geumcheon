import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright-core";
import { SessionSummary } from "../../apps/leaderboard/src/LeaderboardApp";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import { createBootstrapData } from "../../shared/events/bootstrapData";
import { loadEventProfile } from "../../shared/events/eventProfile";
import { buildRecordRow } from "../../shared/csv/fileStore";

const successTime = new Date(2026, 8, 12, 13, 24, 56).getTime();
for (const [name, lastSuccessfulReadAt, readFailed, expected] of [
  ["initial", null, false, "연결 확인 중"],
  ["successful", successTime, false, "연결 정상"],
  ["failed after success", successTime, true, "조회 오류"]
] as const) {
  test(`public board read status renders ${name} without exposing internal errors`, () => {
    const props = { config: DEFAULT_CONFIG, participantCount: 1, geumcheon: true, lastSuccessfulReadAt, readFailed };
    const html = renderToStaticMarkup(createElement(SessionSummary, props));
    assert.match(html, /마지막 조회 시각/);
    assert.ok(html.includes(expected));
    assert.ok(html.includes(lastSuccessfulReadAt === null ? "--:--:--" : "13:24:56"));
    assert.doesNotMatch(html, /https:|token|credential|NAS_API|C:\\Users/);
  });
}

test("legacy event summary does not gain Geumcheon read status", () => {
  const props = { config: DEFAULT_CONFIG, geumcheon: false, lastSuccessfulReadAt: successTime, readFailed: false };
  const html = renderToStaticMarkup(createElement(SessionSummary, props));
  assert.doesNotMatch(html, /마지막 조회 시각|연결 정상/);
});

test("actual React refresh updates time only after fresh success; pending and failure retain time, rows and header position", { timeout: 30_000 }, async (t) => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.route("**/*", (route) => route.abort());
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const row = { ...buildRecordRow({
    participant_name: "합성조회검수", phone_part1: "010", phone_part2: "0000", phone_part3: "0001",
    birth_year: "2000", birth_month: "1", birth_day: "1", privacy_agreed: true,
    privacy_agreed_at: "2026-09-12T00:00:00.000Z", stageTexts: ["가나", "다라", "마바"],
    stageTimesMs: [1000, 1000, 1000], game_mode: "ai_challenge"
  }), record_id: "public-read-fixture", participantKey: "synthetic", participant_avg_cpm: "120", final_cpm: "120",
    challenge_result_label: "참여자 승리", ai_challenge_status: "SUCCESS", final_vs_ai_result: "USER_WIN", result_stage: "3" };
  const state = { mode: "pending", requests: 0, release: undefined as (() => void) | undefined };
  await page.exposeFunction("__readRecords", async () => {
    state.requests++;
    if (state.mode === "pending") await new Promise<void>((resolve) => { state.release = resolve; });
    if (state.mode === "failure") return { ok: false, error: "NAS_API_SECRET https://private.invalid token=secret" };
    if (state.mode === "throw") throw new Error("synthetic IPC failure");
    return { ok: true, data: [row], matchingRecordIds: null };
  });
  const bootstrap = createBootstrapData({ config: DEFAULT_CONFIG, assetBaseUrl: "https://assets.invalid", notices: [],
    mode: "leaderboard", variant: "ai-leaderboard", eventProfile: loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json")) });
  const source = await build({ stdin: { contents: [
    'import React from "react";import{createRoot}from"react-dom/client";',
    'import{LeaderboardApp}from"./apps/leaderboard/src/LeaderboardApp";',
    'window.__ticks=[];window.__clock=' + successTime + ';Date.now=()=>window.__clock;',
    'window.setInterval=(callback)=>{window.__ticks.push(callback);return window.__ticks.length;};',
    'window.typingKing={listRecords:window.__readRecords};',
    'createRoot(document.getElementById("root")).render(React.createElement(LeaderboardApp,{bootstrap:' + JSON.stringify(bootstrap) + '}));'
  ].join("\n"), resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser",
    format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' }, logLevel: "silent" });
  const css = ["apps/shell/src/styles.css", "apps/leaderboard/src/r7-geumcheon.css"].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  await page.setContent('<html data-event-profile="geumcheon-2026"><head><style>' + css + '</style></head><body><div id="root"></div></body></html>');
  await page.addScriptTag({ content: source.outputFiles[0].text });
  await page.locator(".session-count").waitFor();
  const status = page.locator("[data-public-read-state]");
  assert.equal(await status.count(), 1, "one persistent public read status must exist in the fixed summary line");
  assert.equal(await status.getAttribute("data-public-read-state"), "pending");
  assert.equal(await status.getAttribute("data-last-read-at"), "");
  const initialHeader = await page.locator(".ranking-head").boundingBox();
  assert.equal(state.requests, 1);
  state.mode = "success"; state.release!();
  await page.waitForFunction(() => document.querySelector("[data-public-read-state]")?.getAttribute("data-public-read-state") === "connected");
  assert.equal(await status.getAttribute("data-last-read-at"), String(successTime));
  assert.equal(await page.locator('[data-leaderboard-record="public-read-fixture"]').count(), 1);
  for (const mode of ["pending", "failure", "throw", "success"]) {
    state.mode = mode; state.release = undefined;
    await page.evaluate((clock) => { (window as any).__clock = clock; (window as any).__ticks.forEach((callback: () => void) => callback()); }, successTime + 10000);
    if (mode === "pending") {
      await page.waitForTimeout(30);
      assert.equal(await status.getAttribute("data-last-read-at"), String(successTime));
      state.mode = "failure"; state.release!();
    }
    await page.waitForFunction(() => document.querySelector(".ai-ranking")?.getAttribute("aria-busy") === "false");
    const expectedTime = mode === "success" ? successTime + 10000 : successTime;
    assert.equal(await status.getAttribute("data-last-read-at"), String(expectedTime));
    assert.equal(await status.getAttribute("data-public-read-state"), mode === "success" ? "connected" : "error");
    assert.equal(await page.locator('[data-leaderboard-record="public-read-fixture"]').count(), 1);
    assert.deepEqual(await page.locator(".ranking-head").boundingBox(), initialHeader, "status changes must not shift the column header");
    assert.doesNotMatch(await status.innerText(), /NAS_API_SECRET|private\.invalid|token=/);
  }
  assert.equal(state.requests, 5, "one initial request plus four existing refresh ticks; no extra NAS request");
  const evidence = path.resolve(".superpowers/sdd/2026-09-12-rental-v4/public-read-status");
  fs.mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, "public-status-1280x720.png"), fullPage: true });
  fs.writeFileSync(path.join(evidence, "browser-result.json"), JSON.stringify({ evidenceKind: "source-React-browser", initialHeader,
    finalHeader: await page.locator(".ranking-head").boundingBox(), requestCount: state.requests, lastReadAt: await status.getAttribute("data-last-read-at"), rowsPreserved: true, publicRawErrorLeak: false }, null, 2));
});
