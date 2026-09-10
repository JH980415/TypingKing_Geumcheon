import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { chromium, type Page } from "playwright-core";
import { createServer } from "vite";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import { createBootstrapData } from "../../shared/events/bootstrapData";
import { loadEventProfile } from "../../shared/events/eventProfile";
import { buildRecordRow } from "../../shared/csv/fileStore";

// Browser geometry, not a CSS parser. Literal expectations were independently
// measured from PPT12 image11 client crop (0,15,1280,674), excluding Windows UI.
// Catch: a natural-height logo pushing the board down, content-dependent board
// shrinkage, or fixing fit by changing row/font/global scale.
const references = [
  { width: 1280, height: 720, tolerance: 4, board: { x: 29, y: 113.234, width: 1224, height: 592.878 },
    inner: { x: 49, y: 134.599, width: 1183, height: 550.148 },
    tableY: 231.810, controlsRight: 1253 },
  { width: 1920, height: 1080, tolerance: 6, board: { x: 43.5, y: 169.852, width: 1836, height: 889.318 },
    inner: { x: 73.5, y: 201.899, width: 1774.5, height: 825.223 },
    tableY: 347.715, controlsRight: 1879.5 }
];

async function measure(page: Page) {
  return page.evaluate(() => {
    const selectors = [".app", ".leaderboard-header", ".leader-actions", ".leaderboard-board", ".ranking-table", ".ranking-head", ".ranking-body"];
    const boxes = Object.fromEntries(selectors.map((selector) => [selector, document.querySelector(selector)!.getBoundingClientRect().toJSON()]));
    const logo = document.querySelector<HTMLImageElement>(".geumcheon-leaderboard-logo")!;
    const imageBox = logo.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    canvas.width = logo.naturalWidth; canvas.height = logo.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(logo, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = canvas.width, top = canvas.height, right = 0, bottom = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      if (pixels[(y * canvas.width + x) * 4 + 3] >= 8) {
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
      }
    }
    const imageStyle = getComputedStyle(logo);
    const fit = imageStyle.objectFit;
    let paintedWidth = imageBox.width, paintedHeight = imageBox.height;
    if (fit === "contain") {
      const scale = Math.min(imageBox.width / canvas.width, imageBox.height / canvas.height);
      paintedWidth = canvas.width * scale; paintedHeight = canvas.height * scale;
    }
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".ai-ranking .ranking-row"));
    return { boxes, logo: { x: imageBox.x + left / canvas.width * paintedWidth,
      y: imageBox.y + (imageBox.height - paintedHeight) / 2 + top / canvas.height * paintedHeight,
      width: (right - left) / canvas.width * paintedWidth, height: (bottom - top) / canvas.height * paintedHeight },
      imageBox: imageBox.toJSON(), imageFit: fit, rowCount: rows.length,
      rows: rows.map((row) => ({ height: row.getBoundingClientRect().height, font: getComputedStyle(row.querySelector("span")!).fontSize })),
      appTransform: getComputedStyle(document.querySelector(".app")!).transform,
      appZoom: getComputedStyle(document.querySelector(".app")!).zoom,
      documentSize: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      scrollTop: document.querySelector(".ranking-body")!.scrollTop,
      scrollHeight: document.querySelector(".ranking-body")!.scrollHeight,
      clientHeight: document.querySelector(".ranking-body")!.clientHeight };
  });
}

test("PPT12 board anchors and sticky header remain unchanged with the UIV3 logo overlay", { timeout: 120_000 }, async (t) => {
  const evidenceBase = path.resolve("Codex/Evidence/R7/layout-correction-browser");
  fs.mkdirSync(evidenceBase, { recursive: true });
  const output = fs.mkdtempSync(path.join(evidenceBase, "run-"));
  const sourceHashes = Object.fromEntries(["apps/leaderboard/src/r7-geumcheon.css", "apps/leaderboard/src/LeaderboardApp.tsx",
    "tests/events/r7LeaderboardLayout.browser.ts", "events/geumcheon-2026/assets/title_logo_062843.png",
    "Codex/Evidence/R7/layout-correction-reference/PPT12_LAYOUT_MEASUREMENTS.json"].map((file) =>
    [file, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
  const server = await createServer({ configFile: false, root: process.cwd(), esbuild: { jsx: "automatic" },
    cacheDir: path.join(output, "vite-cache"), server: { host: "127.0.0.1", port: 0, open: false, watch: null }, clearScreen: false });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const observations: unknown[] = [];
  try {
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const bootstrap = createBootstrapData({ config: DEFAULT_CONFIG, assetBaseUrl: `${origin}/assets`, notices: [], mode: "leaderboard", variant: "ai-leaderboard",
      eventProfile: loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json")) });
    browser = await chromium.launch({ channel: "msedge", headless: true });
    for (const reference of references) {
      const page = await browser.newPage({ viewport: { width: reference.width, height: reference.height }, deviceScaleFactor: 1 });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      // Only the unavailable Electron IPC boundary is replaced. The real shell,
      // LeaderboardApp, CSS, assets, filtering and row rendering all execute.
      await page.addInitScript({ content: `window.__layoutRows=[];window.typingKing={getBootstrap:async()=>({ok:true,data:${JSON.stringify(bootstrap)}}),listRecords:async()=>({ok:true,data:window.__layoutRows})};` });
      await page.goto(origin);
      try { await page.locator(".ranking-head").waitFor(); }
      catch (error) { console.error({ pageErrors, body: await page.locator("body").innerText() }); throw error; }
      await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0));
      const empty = await measure(page);
      await page.screenshot({ path: path.join(output, `${reference.width}-empty.png`) });
      const record = buildRecordRow({ participant_name: "합성 표시검사", phone_part1: "010", phone_part2: "0000", phone_part3: "0001",
        birth_year: "2000", birth_month: "01", birth_day: "01", privacy_agreed: true, privacy_agreed_at: "2026-09-09T00:00:00.000Z",
        stageTexts: ["검사", "검사", "검사"], stageTimesMs: [1000, 1000, 1000], game_mode: "ai_challenge", final_accuracy: 100 });
      const records = Array.from({ length: 20 }, (_, index) => ({ ...record, record_id: `layout-${index}`, participant_name: `합성표시${index}` }));
      await page.evaluate((value) => { (window as any).__layoutRows = value; }, records);
      await page.getByRole("button", { name: "새로고침", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".ai-ranking .ranking-row").length === 20);
      const populated = await measure(page);
      await page.screenshot({ path: path.join(output, `${reference.width}-populated.png`) });
      // Catch translucent sticky headers leaking underlying row glyphs. The
      // bottom 12px band contains no header labels; scroll 48px places the first
      // 76px row's centered text beneath it without changing viewport geometry.
      const header = populated.boxes[".ranking-head"];
      const headerClip = { x: Math.ceil(header.x) + 8, y: Math.ceil(header.y) + 48,
        width: Math.floor(header.width) - 16, height: 12 };
      const headerBefore = await page.screenshot({ clip: headerClip,
        path: path.join(output, `${reference.width}-header-before-scroll.png`) });
      await page.locator(".ranking-body").evaluate((element) => { element.scrollTop = 48; });
      await page.waitForFunction(() => document.querySelector(".ranking-body")!.scrollTop === 48);
      const headerAfter = await page.screenshot({ clip: headerClip,
        path: path.join(output, `${reference.width}-header-after-scroll.png`) });
      const headerAtScroll = await measure(page);
      const columns = await page.evaluate(() => [".ranking-head", ".ai-ranking .ranking-row"].map((selector) =>
        Array.from(document.querySelector(selector)!.children).map((cell) => {
          const box = cell.getBoundingClientRect(); return { x: box.x, width: box.width };
        })));
      const headerPixels = await page.evaluate(async ({ before, after }) => {
        const images = [before, after].map((base64) => {
          const image = new Image(); image.src = `data:image/png;base64,${base64}`;
          return image;
        });
        await Promise.all(images.map((image) => image.decode()));
        const [first, second] = images.map((image) => {
          const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, canvas.width, canvas.height).data;
        });
        let changedPixels = 0, maximumChannelDelta = 0;
        for (let offset = 0; offset < first.length; offset += 4) {
          let changed = false;
          for (let channel = 0; channel < 4; channel++) {
            const delta = Math.abs(first[offset + channel] - second[offset + channel]);
            changed ||= delta !== 0; maximumChannelDelta = Math.max(maximumChannelDelta, delta);
          }
          if (changed) changedPixels++;
        }
        return { changedPixels, maximumChannelDelta, pixelCount: first.length / 4 };
      }, { before: headerBefore.toString("base64"), after: headerAfter.toString("base64") });
      observations.push({ viewport: reference, state: "header-scroll-pixels", clip: headerClip, actual: headerPixels,
        scrollTop: headerAtScroll.scrollTop, headerBefore: header, headerAfter: headerAtScroll.boxes[".ranking-head"], columns });
      await t.test(`${reference.width} sticky header conceals scrolling row pixels`, async () => {
        assert.equal(headerAtScroll.scrollTop, 48);
        assert.deepEqual(headerAtScroll.boxes[".ranking-head"], header, "sticky header geometry must not move");
        assert.deepEqual(columns[0], columns[1], "header and body columns remain aligned");
        assert.equal(headerPixels.changedPixels, 0, `Scrolled rows changed ${headerPixels.changedPixels} header-band pixels (max channel delta ${headerPixels.maximumChannelDelta})`);
        await page.locator(".ai-ranking .ranking-row").nth(1).click();
        await page.waitForFunction(() => document.querySelectorAll(".ai-ranking .ranking-row.selected").length === 1);
        await page.mouse.click(headerClip.x + 2, headerClip.y + 2);
        await page.waitForFunction(() => document.querySelectorAll(".ai-ranking .ranking-row.selected").length === 0);
      });
      await page.locator(".ai-ranking .ranking-row").last().scrollIntoViewIfNeeded();
      const scrolled = await measure(page);
      await page.screenshot({ path: path.join(output, `${reference.width}-scrolled.png`) });
      for (const [state, actual] of [["empty", empty], ["populated", populated], ["scrolled", scrolled]] as const) {
        observations.push({ viewport: reference, state, actual });
        await t.test(`${reference.width} ${state} measured PPT12 anchors and unscaled rows`, () => {
          assert.deepEqual(pageErrors, []);
          const differences: string[] = [];
          for (const key of ["x", "y", "width", "height"] as const) {
            if (Math.abs(actual.boxes[".leaderboard-board"][key] - reference.board[key]) > reference.tolerance)
              differences.push(`board.${key}: ${actual.boxes[".leaderboard-board"][key]} expected ${reference.board[key]}`);
            if (Math.abs(actual.boxes[".ranking-table"][key] - reference.inner[key]) > reference.tolerance)
              differences.push(`inner.${key}: ${actual.boxes[".ranking-table"][key]} expected ${reference.inner[key]}`);
          }
          if (Math.abs(actual.boxes[".ranking-head"].y - reference.tableY) > reference.tolerance)
            differences.push(`tableHeader.y: ${actual.boxes[".ranking-head"].y} expected ${reference.tableY}`);
          assert.deepEqual(differences, [], differences.join("; "));
          assert.ok(Math.abs(actual.boxes[".leader-actions"].right - reference.controlsRight) <= reference.tolerance);
          // U10 replaces only the obsolete stretched/left logo target. U11 permits
          // controls-only wrapping; original board/inner/header/rows remain checked.
          assert.ok(actual.logo.x + actual.logo.width < actual.boxes[".leader-actions"].left);
          assert.ok(Math.abs(actual.logo.x + actual.logo.width / 2 - actual.boxes[".leaderboard-board"].x - actual.boxes[".leaderboard-board"].width / 2) <= 2);
          assert.ok(Math.abs(actual.logo.y + actual.logo.height / 2 - actual.boxes[".leaderboard-board"].top) <= 2);
          assert.equal(actual.imageFit, "contain");
          assert.ok(Math.abs(actual.imageBox.width / actual.imageBox.height / (2048 / 682) - 1) <= .005);
          assert.ok(actual.boxes[".leader-actions"].bottom <= actual.boxes[".leaderboard-board"].top,
            "unscaled controls must remain above the board");
          assert.equal(actual.appTransform, "none"); assert.equal(actual.appZoom, "1");
          assert.deepEqual(actual.documentSize, [reference.width, reference.height]);
          assert.ok(actual.rows.every((row) => Math.abs(row.height - 76) <= 0.1 && row.font === "14px"));
          assert.deepEqual(actual.boxes[".leaderboard-board"], empty.boxes[".leaderboard-board"]);
          assert.deepEqual(actual.boxes[".ranking-body"], empty.boxes[".ranking-body"]);
          if (state === "scrolled") assert.ok(actual.scrollTop > 0 && actual.scrollHeight > actual.clientHeight);
        });
      }
      await page.close();
    }
  } finally {
    try {
      fs.writeFileSync(path.join(output, "geometry.json"), JSON.stringify({ method: "Real source React/CSS in headless Edge; Electron IPC replaced with synthetic fixtures only", sourceHashes, observations }, null, 2));
    } finally {
      try { await browser?.close(); } finally { await server.close(); }
    }
    console.log(`Layout evidence: ${output}`);
  }
});
