import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { chromium, type Page } from "playwright-core";
import { createServer } from "vite";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import { createBootstrapData } from "../../shared/events/bootstrapData";
import { loadEventProfile } from "../../shared/events/eventProfile";
import { buildRecordRow } from "../../shared/csv/fileStore";

// Breaks caught: stretched or off-center title, clipping/occlusion, moved board,
// changed row metrics, controls that expand beyond their original right area,
// and validation/transport alerts that reflow or cover the fixed ranking table.
const references = [
  { width: 1280, height: 720, board: [29, 113.234375, 1224, 592.890625], inner: [49, 134.59375, 1184, 550.171875], headerY: 231.796875, controlsLeft: 836.28125, controlsRight: 1253, maxCanvasWidth: 366.5625 },
  { width: 1920, height: 1080, board: [43.5, 169.84375, 1836, 889.328125], inner: [73.5, 201.890625, 1776, 825.234375], headerY: 347.703125, controlsLeft: 1382.703125, controlsRight: 1879.5, maxCanvasWidth: 818.40625 }
];

async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (element: Element) => element.getBoundingClientRect().toJSON();
    const boxes = Object.fromEntries([".leaderboard-header", ".leaderboard-board", ".ranking-table", ".ranking-head", ".ranking-body", ".leaderboard-session", ".leader-actions", ".session-count"].map(selector => [selector, rect(document.querySelector(selector)!)]));
    const logo = document.querySelector<HTMLImageElement>(".geumcheon-leaderboard-logo")!;
    const imageBox = rect(logo), style = getComputedStyle(logo);
    const canvas = document.createElement("canvas"); canvas.width = logo.naturalWidth; canvas.height = logo.naturalHeight;
    const context = canvas.getContext("2d")!; context.drawImage(logo, 0, 0);
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = canvas.width, top = canvas.height, right = 0, bottom = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      if (rgba[(y * canvas.width + x) * 4 + 3] >= 8) {
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
      }
    }
    const scale = Math.min(imageBox.width / canvas.width, imageBox.height / canvas.height);
    const paintedWidth = style.objectFit === "contain" ? canvas.width * scale : imageBox.width;
    const paintedHeight = style.objectFit === "contain" ? canvas.height * scale : imageBox.height;
    const paintX = imageBox.x + (imageBox.width - paintedWidth) / 2, paintY = imageBox.y + (imageBox.height - paintedHeight) / 2;
    const visible = { x: paintX + left / canvas.width * paintedWidth, y: paintY + top / canvas.height * paintedHeight,
      width: (right - left) / canvas.width * paintedWidth, height: (bottom - top) / canvas.height * paintedHeight };
    // Hit testing at upper/lower halves catches the board covering the overlay.
    const oldPointerEvents = logo.style.pointerEvents; logo.style.pointerEvents = "auto";
    const onTop = [-1, 1].map(direction => document.elementFromPoint(visible.x + visible.width / 2, boxes[".leaderboard-board"].y + direction * visible.height / 4) === logo);
    logo.style.pointerEvents = oldPointerEvents;
    const ancestors = []; for (let parent = logo.parentElement; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent); if ([css.overflowX, css.overflowY].some(value => ["hidden", "clip", "auto", "scroll"].includes(value))) ancestors.push(rect(parent));
    }
    const alert = document.querySelector<HTMLElement>(".leaderboard-board > .leaderboard-alert");
    const alertStyle = alert && getComputedStyle(alert);
    return { boxes, imageBox, visible, paintedWidth, paintedHeight, alphaBounds: [left, top, right, bottom], logoCount: document.querySelectorAll(".geumcheon-leaderboard-logo").length,
      alert: alert && { rect: rect(alert), text: alert.textContent, role: alert.getAttribute("role"), font: alertStyle!.fontSize,
        color: alertStyle!.color, background: alertStyle!.backgroundColor, padding: alertStyle!.padding, scrollHeight: alert.scrollHeight, clientHeight: alert.clientHeight,
        onTop: document.elementFromPoint(alert.getBoundingClientRect().x + 8, alert.getBoundingClientRect().y + 8) === alert },
      natural: [canvas.width, canvas.height], pointerEvents: style.pointerEvents, opacity: style.opacity, onTop, clippingAncestors: ancestors,
      controls: Array.from(document.querySelectorAll(".uiv3-search-controls select, .uiv3-search-controls input, .uiv3-search-controls button")).map(element => ({ tag: element.tagName, text: element.textContent, rect: rect(element), font: getComputedStyle(element).fontSize })),
      rows: Array.from(document.querySelectorAll(".ai-ranking .ranking-row")).map(row => ({ height: rect(row).height, font: getComputedStyle(row.querySelector("span")!).fontSize })),
      scrollTop: document.querySelector(".ranking-body")!.scrollTop,
      appTransform: getComputedStyle(document.querySelector(".app")!).transform, appZoom: getComputedStyle(document.querySelector(".app")!).zoom,
      documentSize: [document.documentElement.scrollWidth, document.documentElement.scrollHeight] };
  });
}

test("UIV3 title preserves original canvas, alpha center, fixed board and bounded search at both viewports", { timeout: 120_000 }, async (t) => {
  const base = path.resolve("Codex/Evidence/UIV3_20260910/source-checks/leaderboard-layout"); fs.mkdirSync(base, { recursive: true });
  const output = fs.mkdtempSync(path.join(base, "run-"));
  const sourceHashes = Object.fromEntries(["apps/leaderboard/src/LeaderboardApp.tsx", "apps/leaderboard/src/r7-geumcheon.css", "tests/events/uiv3LeaderboardLayout.browser.ts"].map(file => [file, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
  const server = await createServer({ configFile: false, root: process.cwd(), esbuild: { jsx: "automatic" }, cacheDir: path.join(output, "vite-cache"), server: { host: "127.0.0.1", port: 0, open: false, watch: null }, clearScreen: false });
  const observations: unknown[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const bootstrap = createBootstrapData({ config: DEFAULT_CONFIG, assetBaseUrl: `${origin}/assets`, notices: [], mode: "leaderboard", variant: "ai-leaderboard", eventProfile: loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json")) });
    browser = await chromium.launch({ channel: "msedge", headless: true });
    for (const reference of references) {
      const page = await browser.newPage({ viewport: { width: reference.width, height: reference.height }, deviceScaleFactor: 1 });
      const pageErrors: string[] = []; page.on("pageerror", error => pageErrors.push(error.message));
      // Only unavailable Electron IPC is substituted; actual React, CSS and assets run.
      await page.addInitScript({ content: `window.__layoutRows=[];window.__layoutError="";window.typingKing={getBootstrap:async()=>({ok:true,data:${JSON.stringify(bootstrap)}}),listRecords:async()=>window.__layoutError?({ok:false,error:window.__layoutError}):({ok:true,data:window.__layoutRows})};` });
      await page.addInitScript("window.__name = (value) => value;");
      await page.goto(origin); await page.locator(".ranking-head").waitFor();
      await page.waitForFunction(() => Array.from(document.images).every(image => image.complete && image.naturalWidth > 0));
      const imageUrl = await page.locator(".geumcheon-leaderboard-logo").getAttribute("src");
      const imageBytes = await (await page.request.get(new URL(imageUrl!, origin).href)).body();
      await t.test(`${reference.width} active title bytes`, () => assert.equal(createHash("sha256").update(imageBytes).digest("hex"), "eea89947c6ea42fc0dc6045c6398301d8e480dcb510de7a83f1db9766f0e22ee"));
      const record = buildRecordRow({ participant_name: "합성 검사", phone_part1: "010", phone_part2: "0000", phone_part3: "0001", birth_year: "2000", birth_month: "01", birth_day: "01", privacy_agreed: true, privacy_agreed_at: "2026-09-09T00:00:00.000Z", stageTexts: ["검사", "검사", "검사"], stageTimesMs: [1000, 1000, 1000], game_mode: "ai_challenge", final_accuracy: 100 });
      let populatedBaseline: Awaited<ReturnType<typeof measure>> | undefined;
      for (const state of ["empty", "populated", "scrolled", "long-draft", "invalid-abc", "invalid-010a", "transport-error", "long-error", "recovery"] as const) {
        if (state === "populated") {
          const records = Array.from({ length: 20 }, (_, index) => ({ ...record, record_id: `uiv3-layout-${index}`, participant_name: `합성검사${index}` }));
          await page.evaluate(value => { (window as any).__layoutRows = value; }, records);
          await page.getByRole("button", { name: "새로고침", exact: true }).click();
          await page.waitForFunction(() => document.querySelectorAll(".ai-ranking .ranking-row").length === 20);
        }
        if (state === "scrolled") await page.locator(".ai-ranking .ranking-row").last().scrollIntoViewIfNeeded();
        if (state === "long-draft") await page.getByRole("textbox", { name: "검색어", exact: true }).fill("합성긴검색어".repeat(40));
        if (state === "invalid-abc" || state === "invalid-010a") {
          await page.getByRole("combobox", { name: "검색 구분" }).selectOption("contact");
          await page.getByRole("textbox", { name: "검색어", exact: true }).fill(state === "invalid-abc" ? "abc" : "010a");
          await page.getByRole("button", { name: "검색", exact: true }).click();
          await page.getByRole("alert").filter({ hasText: "연락처는 숫자, 하이픈, 공백만 입력해 주세요." }).waitFor();
        }
        if (state === "transport-error") {
          await page.getByRole("combobox", { name: "검색 구분" }).selectOption("name");
          await page.evaluate(() => { (window as any).__layoutError = "ETIMEDOUT synthetic transport"; });
          await page.getByRole("button", { name: "새로고침", exact: true }).click();
          await page.getByRole("alert").filter({ hasText: "NAS 기록을 읽을 수 없습니다." }).waitFor();
        }
        if (state === "long-error") {
          await page.evaluate(() => { (window as any).__layoutError = "합성 조회 오류 안내입니다. ".repeat(120) + "안내 끝"; });
          await page.getByRole("button", { name: "새로고침", exact: true }).click();
          await page.getByRole("alert").filter({ hasText: "안내 끝" }).waitFor();
        }
        if (state === "recovery") {
          await page.evaluate(() => { (window as any).__layoutError = ""; });
          await page.getByRole("button", { name: "새로고침", exact: true }).click();
          await page.getByRole("alert").waitFor({ state: "detached" });
        }
        const actual = await measure(page); observations.push({ viewport: reference, state, actual });
        if (state === "populated") populatedBaseline = actual;
        await page.screenshot({ path: path.join(output, `${reference.width}-${state}.png`) });
        await t.test(`${reference.width} ${state} fixed geometry`, () => {
          assert.deepEqual(pageErrors, []);
          for (const [selector, expected] of [[".leaderboard-board", reference.board], [".ranking-table", reference.inner]] as const) {
            ["x", "y", "width", "height"].forEach((key, index) => assert.ok(Math.abs(actual.boxes[selector][key] - expected[index]) <= 2, `${selector}.${key}`));
          }
          assert.ok(Math.abs(actual.boxes[".ranking-head"].y - reference.headerY) <= 2);
          assert.equal(actual.boxes[".ranking-head"].height, 64);
          assert.ok(actual.rows.every(row => row.height === 76 && row.font === "14px"));
          assert.equal(actual.appTransform, "none"); assert.equal(actual.appZoom, "1");
          assert.deepEqual(actual.documentSize, [reference.width, reference.height]);
          if (state === "scrolled") assert.ok(actual.scrollTop > 0);
          if (populatedBaseline) {
            assert.equal(actual.rows.length, 20, "errors and recovery retain the existing row snapshot");
            for (const selector of [".leaderboard-board", ".ranking-table", ".ranking-head", ".ranking-body", ".leaderboard-session", ".session-count", ".leader-actions"]) {
              for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(actual.boxes[selector][key] - populatedBaseline.boxes[selector][key]) <= 2, `${state} ${selector}.${key} must not reflow`);
            }
          }
          if (state === "recovery") assert.equal(actual.alert, null);
        });
        await t.test(`${reference.width} ${state} U10 original ratio and alpha center`, () => {
          assert.deepEqual(actual.natural, [2048, 682]); assert.deepEqual(actual.alphaBounds, [21, 66, 2027, 607]);
          assert.equal(actual.logoCount, 1);
          // Literal safe maxima derived from frozen board/control rectangles,
          // not from the CSS expression being tested.
          assert.ok(Math.abs(actual.imageBox.width - reference.maxCanvasWidth) <= 2, "largest full-canvas fit within clearances");
          assert.ok(Math.abs(actual.paintedWidth / actual.paintedHeight / (2048 / 682) - 1) <= .005, "original canvas ratio");
          const board = actual.boxes[".leaderboard-board"];
          assert.ok(Math.abs(actual.visible.x + actual.visible.width / 2 - board.x - board.width / 2) <= 2, "visible center X");
          assert.ok(Math.abs(actual.visible.y + actual.visible.height / 2 - board.y) <= 2, "visible center Y at outer border");
          assert.ok(actual.imageBox.y >= 8 - .1, "full canvas top clearance");
          assert.equal(actual.pointerEvents, "none"); assert.equal(actual.opacity, "1"); assert.deepEqual(actual.onTop, [true, true], "both halves above board");
          for (const ancestor of actual.clippingAncestors) assert.ok(actual.imageBox.left >= ancestor.left && actual.imageBox.right <= ancestor.right && actual.imageBox.top >= ancestor.top && actual.imageBox.bottom <= ancestor.bottom, "full canvas unclipped");
          for (const selector of [".ranking-head", ".session-count", ".leader-actions"]) {
            const other = actual.boxes[selector], v = actual.visible;
            assert.ok(v.x + v.width + 12 <= other.left || v.x >= other.right + 12 || v.y + v.height + 12 <= other.top || v.y >= other.bottom + 12, `${selector} clearance`);
          }
        });
        await t.test(`${reference.width} ${state} U11 controls stay in current right region`, () => {
          assert.ok(actual.controls.length >= 5, "field/input/search/refresh/admin controls present");
          const actions = actual.boxes[".leader-actions"];
          assert.ok(actions.left >= reference.controlsLeft - 2 && Math.abs(actions.right - reference.controlsRight) <= 2);
          assert.ok(actions.top >= 0 && actions.bottom <= actual.boxes[".leaderboard-board"].top);
          for (const control of actual.controls) {
            assert.ok(control.rect.left >= actions.left && control.rect.right <= actions.right + .1);
            assert.ok(control.rect.width >= (control.tag === "SELECT" ? 80 : control.tag === "INPUT" ? 160 : control.text === "검색" ? 56 : 0));
            assert.equal(control.font, control.tag === "BUTTON" && reference.width === 1280 ? "14px" : "16px");
            assert.equal(control.rect.height, control.tag === "BUTTON" ? (reference.width === 1280 ? 46 : 56) : (reference.width === 1280 ? 44 : 58));
          }
          const [select, input, search, refresh, admin] = actual.controls;
          assert.ok(Math.abs(input.rect.left - select.rect.right - 8) <= .1);
          assert.ok(Math.abs(search.rect.left - input.rect.right - 8) <= .1);
          assert.ok(Math.abs(admin.rect.left - refresh.rect.right - 8) <= .1);
          assert.ok(Math.abs(refresh.rect.top - Math.max(select.rect.bottom, input.rect.bottom, search.rect.bottom) - 8) <= .1);
        });
        if (["invalid-abc", "invalid-010a", "transport-error", "long-error"].includes(state)) {
          await t.test(`${reference.width} ${state} alert is readable in unused space without covering fixed content`, async () => {
            assert.ok(actual.alert); assert.equal(actual.alert.role, "alert"); assert.equal(actual.alert.font, "16px");
            assert.equal(actual.alert.color, "rgb(196, 0, 128)"); assert.equal(actual.alert.background, "rgb(255, 244, 247)"); assert.equal(actual.alert.padding, "10px 14px");
            if (state.startsWith("invalid-")) assert.equal(actual.alert.text, "연락처는 숫자, 하이픈, 공백만 입력해 주세요.");
            if (state === "transport-error") assert.equal(actual.alert.text, "NAS 기록을 읽을 수 없습니다. NAS 연결과 조회 전용 권한을 확인해 주세요.");
            const alert = actual.alert.rect;
            assert.ok(Math.abs(alert.left - reference.controlsLeft) <= 2, "error uses the fixed right-side region");
            assert.ok(Math.abs(alert.right - (reference.inner[0] + reference.inner[2])) <= 2, "error stays within the inner table edge");
            assert.ok(Math.abs(alert.top - reference.inner[1]) <= 2, "error starts in the unused inner-table top band");
            assert.equal(actual.alert.onTop, true, "error is visible above the table background");
            for (const other of [actual.imageBox, actual.boxes[".session-count"], actual.boxes[".ranking-head"], actual.boxes[".leader-actions"]]) {
              assert.ok(alert.right + 12 <= other.left || alert.left >= other.right + 12 || alert.bottom + 12 <= other.top || alert.top >= other.bottom + 12, "error clears full logo/count/header/buttons by 12px");
            }
            if (state === "long-error") {
              assert.equal(actual.alert.text, "합성 조회 오류 안내입니다. ".repeat(120) + "안내 끝");
              assert.ok(actual.alert.scrollHeight > actual.alert.clientHeight, "full long error remains in a bounded scroll area");
              const alertElement = page.getByRole("alert"); await alertElement.focus(); await page.keyboard.press("End");
              await page.waitForFunction(() => document.querySelector(".leaderboard-alert")!.scrollTop > 0);
            }
          });
        }
      }
      await page.close();
    }
  } finally {
    fs.writeFileSync(path.join(output, "geometry.json"), JSON.stringify({ method: "Actual source in headless Edge; synthetic IPC only; not packaged/native acceptance", sourceHashes, observations }, null, 2));
    await browser?.close(); await server.close(); console.log(`UIV3 layout evidence: ${output}`);
  }
});
