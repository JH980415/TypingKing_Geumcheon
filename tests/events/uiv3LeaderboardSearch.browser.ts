import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LeaderboardApp } from "../../apps/leaderboard/src/LeaderboardApp";
import { chromium, type Page } from "playwright-core";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import { createBootstrapData } from "../../shared/events/bootstrapData";
import { loadEventProfile } from "../../shared/events/eventProfile";
import { buildRecordRow } from "../../shared/csv/fileStore";
import { listGeumcheonRecords } from "../../electron/geumcheonConnection";
import type { RecordListRequest, RecordRow } from "../../shared/types";

function makeRow(id: string, name: string, cpm: number, phone = "01099990000"): RecordRow {
  return { ...buildRecordRow({ participant_name: name, phone_part1: phone.slice(0, 3), phone_part2: phone.slice(3, 7),
    phone_part3: phone.slice(7), birth_year: "2000", birth_month: "1", birth_day: "1", privacy_agreed: true,
    privacy_agreed_at: "2026-09-10T00:00:00.000Z", stageTexts: ["가나", "다라", "마바"],
    stageTimesMs: [1000, 1000, 1000], game_mode: "ai_challenge" }),
    record_id: id, participantKey: name, participant_avg_cpm: String(cpm), final_cpm: String(cpm),
    challenge_result_label: "참여자 승리", ai_challenge_status: "SUCCESS", final_vs_ai_result: "USER_WIN", result_stage: "3" };
}
function fixtures() {
  return [...Array.from({ length: 125 }, (_, index) => makeRow("filler-" + index, "합성기록" + index, 1000 - index)),
    makeRow("target-best", "합성찾는이", 100, "01012345678"), makeRow("target-worse", "합성찾는이", 50, "01022225678"),
    makeRow("mirror", "합성별칭", 90, "01088885678"),
    { ...makeRow("ai-win", "합성패배", 80), challenge_result_label: "금나래 승리", ai_challenge_status: "FAIL", final_vs_ai_result: "AI_WIN" },
    { ...makeRow("interrupted", "합성중단", 70), challenge_result_label: "중단 패배", ai_challenge_status: "FAIL", final_vs_ai_result: "AI_WIN" }
  ] as RecordRow[];
}
async function mount(t: any, initialRows = fixtures()) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const state = { rows: initialRows, requests: [] as Array<RecordListRequest | undefined>, fail: false,
    delayNext: false, release: undefined as (() => void) | undefined };
  await page.exposeFunction("__records", async (request?: RecordListRequest) => {
    state.requests.push(request);
    // Only unavailable Electron IPC is replaced. Both React and the protected snapshot matcher are real.
    const snapshot = state.rows.map((row) => ({ ...row }));
    const delayed = state.delayNext; state.delayNext = false;
    if (delayed) await new Promise<void>((resolve) => { state.release = resolve; });
    if (state.fail) return { ok: false, error: "기록을 읽을 수 없습니다." };
    const options = { connection: { source: "review" as const, runtime: { loadRecords: async () => ({ rows: snapshot }) } },
      role: "leaderboard" as const, eventProfileId: "geumcheon-2026", sessionKind: "official",
      readLegacy: () => { throw Error("unexpected legacy read"); } };
    const result = request === undefined
      ? { rows: await listGeumcheonRecords(options), matchingRecordIds: null }
      : await listGeumcheonRecords({ ...options, request });
    return { ok: true, data: result.rows, matchingRecordIds: result.matchingRecordIds };
  });
  const bootstrap = createBootstrapData({ config: { ...DEFAULT_CONFIG, leaderboardMode: "best_record_only" },
    assetBaseUrl: "https://assets.invalid", notices: [], mode: "leaderboard", variant: "ai-leaderboard",
    eventProfile: loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json")) });
  const source = await build({ stdin: { contents: [
    'import React from "react"; import {createRoot} from "react-dom/client";',
    'import {LeaderboardApp} from "./apps/leaderboard/src/LeaderboardApp";',
    'window.__ticks=[];window.setInterval=(callback)=>{window.__ticks.push(callback);return window.__ticks.length};',
    'window.typingKing={listRecords:window.__records,validateAdmin:async()=>({ok:true,data:{adminName:"synthetic"}})};',
    'createRoot(document.getElementById("root")).render(React.createElement(LeaderboardApp,{bootstrap:' + JSON.stringify(bootstrap) + '}));'
  ].join("\n"), resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser",
    format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' }, logLevel: "silent" });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: source.outputFiles[0].text });
  await page.waitForFunction(() => document.querySelectorAll(".ai-row").length > 120);
  return { page, state };
}
async function ids(page: Page) { return page.locator(".ai-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-leaderboard-record"))); }
async function waitIds(page: Page, want: string[]) {
  await page.waitForFunction((expected) => JSON.stringify(Array.from(document.querySelectorAll(".ai-row"), (row) =>
    row.getAttribute("data-leaderboard-record"))) === JSON.stringify(expected), want);
}
async function tick(page: Page) { await page.evaluate(() => (window as any).__ticks.forEach((callback: () => void) => callback())); }

test("busy indicator spans pending explicit and manual refresh until success or error settles", { timeout: 30_000 }, async (t) => {
  const { page, state } = await mount(t);
  const table = page.locator(".ranking-table.ai-ranking");
  await page.getByRole("textbox", { name: "검색어" }).fill("찾는");
  for (const phase of ["explicit", "manual", "error"] as const) {
    state.release = undefined;
    state.delayNext = true;
    state.fail = phase === "error";
    await page.getByRole("button", { name: phase === "explicit" ? "검색" : "새로고침", exact: true }).click();
    const deadline = Date.now() + 3000;
    while (!state.release && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(state.release, phase + " request reached the delayed IPC boundary");
    try {
      assert.equal(await table.getAttribute("aria-busy"), "true", phase + " must remain busy while its response is pending");
    } finally {
      state.release();
    }
    await page.waitForFunction(() => document.querySelector(".ranking-table.ai-ranking")?.getAttribute("aria-busy") === "false");
    if (phase === "error") {
      assert.ok(await page.locator(".leaderboard-alert").isVisible());
    } else {
      assert.deepEqual(await ids(page), ["target-best"]);
    }
  }
});


test("other-event leaderboard retains existing labels and live-search controls", () => {
  const bootstrap = createBootstrapData({ config: DEFAULT_CONFIG, assetBaseUrl: "https://assets.invalid", notices: [],
    mode: "leaderboard", variant: "ai-leaderboard", eventProfile: loadEventProfile(path.resolve("events/skillup-2026/event.config.json")) });
  const html = renderToStaticMarkup(createElement(LeaderboardApp, { bootstrap }));
  assert.match(html, /참여자명/);
  assert.match(html, /placeholder="기록 검색"/);
  assert.doesNotMatch(html, /도전자명|uiv3-search-controls/);
});

test("Geumcheon rendered labels change presentation while preserving interruption and masked cells", async (t) => {
  const { page } = await mount(t);
  assert.match(await page.locator(".ai-head").innerText(), /도전자명/);
  assert.match(await page.locator('[data-leaderboard-record="target-best"]').innerText(), /도전자 승리/);
  assert.match(await page.locator('[data-leaderboard-record="ai-win"]').innerText(), /AI 금나래 승리/);
  assert.match(await page.locator('[data-leaderboard-record="interrupted"]').innerText(), /중단 패배/);
  assert.doesNotMatch(await page.locator(".ranking-body").innerText(), /합성찾는이|01012345678/);
});

test("submitted search preserves whole-snapshot rank, mode, masking, applied refresh and IME draft", async (t) => {
  const { page, state } = await mount(t);
  assert.equal(await page.getByRole("combobox", { name: "검색 구분" }).count(), 1);
  const input = page.getByRole("textbox", { name: "검색어" });
  assert.equal(await input.getAttribute("placeholder"), "성명을 입력하세요");
  const initialIds = await ids(page);
  await input.fill("찾는");
  assert.deepEqual(await ids(page), initialIds, "typing must not apply");
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  assert.deepEqual(await ids(page), initialIds, "composing Enter must not submit");
  await input.dispatchEvent("compositionend", { data: "는" });
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await waitIds(page, ["target-best"]);
  assert.equal(await page.locator(".ai-row .rank-number").innerText(), "126위");
  await input.fill("미제출");
  const requestsBefore = state.requests.length;
  await tick(page);
  await page.waitForFunction(() => document.querySelectorAll(".ai-row").length === 1);
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await waitIds(page, ["target-best"]);
  assert.ok(state.requests.length > requestsBefore);
  assert.deepEqual(state.requests.at(-1), { search: { field: "name", term: "찾는" } });
  assert.equal(await input.inputValue(), "미제출");
  await page.getByRole("combobox", { name: "검색 구분" }).selectOption("contact");
  assert.equal(await input.getAttribute("placeholder"), "연락처 일부를 입력하세요");
  await input.fill("2222"); await input.press("Enter");
  await waitIds(page, []);
  assert.equal(await page.getByText("검색 결과가 없습니다.", { exact: true }).count(), 1,
    "best selection precedes filtering: a matching inferior record must not replace its nonmatching best record");
  await page.getByRole("combobox", { name: "검색 구분" }).selectOption("name");
  await input.fill("찾는"); await input.press("Enter"); await waitIds(page, ["target-best"]);
  await page.getByRole("button", { name: "관리자", exact: true }).click();
  await page.locator('input[type="password"]').fill("synthetic");
  await page.getByRole("button", { name: "진입", exact: true }).click();
  await page.getByRole("button", { name: "전체기록 보기", exact: true }).click();
  await waitIds(page, ["target-best", "target-worse"]);
  await input.fill("   "); await input.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".ai-row").length === 130);
  assert.equal(await page.getByRole("button", { name: "전체기록 보기", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("combobox", { name: "검색 구분" }).selectOption("contact");
  assert.equal(await input.inputValue(), "");
  await input.fill("010-1234"); await input.press("Enter");
  await waitIds(page, ["target-best"]);
  assert.equal(await page.locator(".ai-row").first().locator(".rank-number").innerText(), "126위");
  // Mid-number edits leave masked digits unchanged; refreshed IDs must still change.
  state.rows = state.rows.map((row) => row.record_id.startsWith("target-") ? { ...row, phone_full: "01077775678" } : row);
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await waitIds(page, []);
  assert.equal(await page.getByText("검색 결과가 없습니다.", { exact: true }).count(), 1);
  const beforeInvalid = state.requests.length;
  await input.fill("123x"); await input.press("Enter");
  assert.match(await page.locator(".leaderboard-alert").innerText(), /연락처/);
  assert.equal(state.requests.length, beforeInvalid, "invalid contact must not turn into a full-list request");
  await input.fill("9".repeat(300)); await input.press("Enter"); await waitIds(page, []);
  assert.equal(await input.inputValue(), "9".repeat(300));
  state.fail = true; await tick(page);
  await page.waitForFunction(() => Boolean(document.querySelector(".leaderboard-alert")));
  assert.equal(await page.getByText("검색 결과가 없습니다.", { exact: true }).count(), 0, "failure must not masquerade as zero results");
});

test("changing field discards an older in-flight response without resetting best mode", async (t) => {
  const { page, state } = await mount(t);
  assert.equal(await page.getByRole("combobox", { name: "검색 구분" }).count(), 1);
  const original = await ids(page);
  state.delayNext = true;
  await page.getByRole("textbox", { name: "검색어" }).fill("찾는");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  while (!state.release) await new Promise((resolve) => setTimeout(resolve, 5));
  await page.getByRole("combobox", { name: "검색 구분" }).selectOption("contact");
  await waitIds(page, original);
  state.release();
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.deepEqual(await ids(page), original, "stale response cannot restore the old applied search");
  assert.equal(await page.getByRole("textbox", { name: "검색어" }).inputValue(), "");
  assert.deepEqual(state.requests.at(-1), { search: null });
});
