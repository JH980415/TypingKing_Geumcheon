import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium, type Page } from "playwright-core";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import { createBootstrapData } from "../../shared/events/bootstrapData";
import { loadEventProfile } from "../../shared/events/eventProfile";
import { parseDeploymentProfile } from "../../electron/deploymentProfile";
import { profileFixture } from "./rentalV4Fixture";

const failureMessage = "회차 적용 검증에 실패했습니다.";

async function openAdmin(page: Page) {
  await page.getByRole("button", { name: "관리자 모드", exact: true }).click();
  await page.locator('input[type="password"]').fill("synthetic-admin");
  await page.getByRole("button", { name: "비밀번호 확인", exact: true }).click();
  await page.getByRole("button", { name: "현재 회차 적용", exact: true }).waitFor();
}

// These cases catch loss of the pending transition at either parent boundary,
// premature unlock after success, and treating an unknown IPC outcome as failure.
for (const operation of ["session", "profile"] as const) {
  for (const outcome of ["failure", "success", "unknown", "inflight", "draw-inflight"] as const) {
    test(`v4 ${operation} transition protects actual admin/start UI until ${outcome}`, { timeout: 30_000 }, async (t) => {
      const browser = await chromium.launch({ channel: "msedge", headless: true });
      t.after(() => browser.close());
      const page = await browser.newPage();
      await page.route("**/*", (route) => route.abort());
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const bootstrap = createBootstrapData({
        config: DEFAULT_CONFIG, assetBaseUrl: "https://assets.invalid", notices: [], mode: "game", variant: "ai",
        eventProfile: loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json")),
        deviceProfile: parseDeploymentProfile(profileFixture()).device
      });
      const source = await build({
        stdin: { contents: [
          'import React from "react";import{createRoot}from"react-dom/client";',
          'import{TypingGameApp}from"./apps/typing-game/src/TypingGameApp";',
          `const bootstrap=${JSON.stringify(bootstrap)};const outcome=${JSON.stringify(outcome)};`,
          'window.__drawCalls=0;window.__readinessCalls=0;window.__transitionCalls=0;window.__transitionArgs=[];',
          'const transition=(...args)=>{window.__transitionCalls++;window.__transitionArgs=args;return new Promise((resolve,reject)=>{window.__resolveTransition=resolve;window.__rejectTransition=reject;});};',
          'window.typingKing={getOneDriveSettings:async()=>({ok:true,data:bootstrap.config}),validateAdmin:async()=>({ok:true}),listStageTexts:async()=>({ok:true,data:[]}),getQueuedRecordStatus:async()=>({ok:true,data:{count:0}}),getDeploymentStatus:async()=>({ok:true}),setDeploymentSession:transition,applyDeploymentProfile:transition,chooseDeploymentProfile:async()=>({ok:true,data:{fileName:"synthetic-profile.json",deviceId:"PC01",eventId:"geumcheon-science-festival-2026",role:"player",session:{dayNo:1,roundNo:2},expiresAt:"2099-01-01T00:00:00.000Z"}}),drawStageTexts:async()=>{window.__drawCalls++;if(outcome==="draw-inflight")return new Promise(resolve=>{window.__resolveDraw=resolve;});return {ok:false,error:"synthetic draw stop"};},checkGameStartReadiness:async()=>{window.__readinessCalls++;if(outcome==="draw-inflight")return {ok:true,data:{ready:true}};if(outcome==="inflight")return new Promise(resolve=>{window.__resolveReadiness=resolve;});return {ok:false,error:"synthetic readiness stop"};}};',
          'createRoot(document.getElementById("root")).render(React.createElement(TypingGameApp,{bootstrap}));'
        ].join("\n"), resolveDir: process.cwd(), loader: "tsx" },
        bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
        define: { "process.env.NODE_ENV": '"test"' }, logLevel: "silent",
        plugins: [{ name: "unused-browser-filesystem", setup(plugin) {
          plugin.onResolve({ filter: /^node:fs$/ }, () => ({ path: "node:fs", namespace: "browser-filesystem" }));
          plugin.onLoad({ filter: /.*/, namespace: "browser-filesystem" }, () => ({ contents: "export default {};", loader: "js" }));
        } }]
      });
      await page.setContent('<html><body><div id="root"></div></body></html>');
      await page.addScriptTag({ content: source.outputFiles[0].text });
      await page.locator(".entry-form-group .field input").first().fill("합성검증");
      await page.locator(".phone-row input").nth(0).fill("0000");
      await page.locator(".phone-row input").nth(1).fill("1234");
      for (const [i, value] of ["2000", "1", "1"].entries()) await page.locator(".birth-row select").nth(i).selectOption(value);
      await page.locator(".check-line input").check();
      const start = page.getByRole("button", { name: "시작", exact: true });
      assert.equal(await start.isEnabled(), true, "valid participant starts unlocked");
      if (outcome.endsWith("inflight")) {
        await start.click();
        await page.waitForFunction((drawing) => typeof (window as any)[drawing ? "__resolveDraw" : "__resolveReadiness"] === "function", outcome === "draw-inflight");
      }
      const readinessBeforeTransition = outcome.endsWith("inflight") ? 1 : 0;
      await openAdmin(page);
      if (operation === "profile") await page.getByRole("button", { name: "관리자 프로필 선택", exact: true }).click();
      const applyLabel = operation === "session" ? "현재 회차 적용" : "프로필 적용·재시작";
      const apply = page.getByRole("button", { name: applyLabel, exact: true });
      await apply.waitFor();
      // Synchronous clicks also exercise the parent handler before React commits
      // the disabled rendering, so a local child-only state cannot protect it.
      await apply.evaluate((button) => {
        (button as HTMLButtonElement).click();
        (document.querySelector(".entry-panel .primary-button") as HTMLButtonElement).click();
      });
      await page.waitForFunction(() => (window as any).__transitionCalls === 1);
      assert.equal(await start.isDisabled(), true, "normal start stays disabled while transition is unresolved");
      assert.equal(await page.evaluate(() => (window as any).__readinessCalls), readinessBeforeTransition, "same-turn start never reaches storage readiness");
      const close = page.locator(".admin-modal .icon-button");
      const home = page.getByRole("button", { name: "메인화면으로 돌아가기", exact: true });
      const debug = page.getByRole("button", { name: "AI 타자왕 디버그 시작", exact: true });
      for (const control of [close, home, debug]) {
        assert.equal(await control.isDisabled(), true, "every admin exit/debug control is disabled");
        await control.evaluate((button) => (button as HTMLButtonElement).click());
        assert.equal(await page.locator(".admin-modal.wide").count(), 1, "pending transition keeps admin mounted");
      }
      assert.equal(await page.locator(".entry-form-group .field input").first().inputValue(), "합성검증");
      assert.equal(await page.evaluate(() => (window as any).__readinessCalls), readinessBeforeTransition);
      if (operation === "session") assert.deepEqual(await page.evaluate(() => (window as any).__transitionArgs), [1, 1]);

      if (outcome === "inflight") {
        await page.evaluate(async () => {
          (window as any).__resolveReadiness({ ok: true, data: { ready: true } });
          await new Promise(requestAnimationFrame);
        });
        assert.equal(await page.evaluate(() => (window as any).__drawCalls), 0, "a start waiting before transition must not resume into stage selection");
        assert.equal(await page.locator(".admin-modal.wide").count(), 1);
        assert.equal(await start.isDisabled(), true);
      } else if (outcome === "draw-inflight") {
        await page.evaluate(async () => {
          (window as any).__resolveDraw({ ok: true, data: { selections: [1, 2, 3].map(stageNumber => ({
            id: `synthetic-stage-${stageNumber}`, catalogVersion: "synthetic-v1", stageNumber, text: "합성 검증 문구"
          })) } });
          await new Promise(requestAnimationFrame);
        });
        assert.equal(await page.locator(".entry-panel").count(), 1, "stage selection waiting before transition must not open a game");
        assert.equal(await page.locator(".admin-modal.wide").count(), 1);
      } else if (outcome === "success" && operation === "session") {
        const navigation = page.waitForEvent("framenavigated");
        await page.evaluate(() => (window as any).__resolveTransition({ ok: true }));
        await navigation;
        assert.equal(await page.locator("#root").count(), 0, "successful session apply reloads the document");
      } else {
        await page.evaluate(({ outcome, failureMessage }) => {
          if (outcome === "unknown") (window as any).__rejectTransition(new Error("synthetic lost IPC response"));
          else (window as any).__resolveTransition(outcome === "success" ? { ok: true } : { ok: false, error: failureMessage });
        }, { outcome, failureMessage });
        if (outcome === "failure") {
          await page.getByText(failureMessage, { exact: true }).waitFor();
          for (const control of [start, close, home, debug, apply]) assert.equal(await control.isEnabled(), true, "definitive failure releases the UI");
          await start.click();
          assert.equal(await page.evaluate(() => (window as any).__readinessCalls), 1);
          await home.click();
          assert.equal(await page.locator(".admin-modal").count(), 0);
          await openAdmin(page);
          await page.locator(".admin-modal .icon-button").click();
          assert.equal(await page.locator(".admin-modal").count(), 0);
          await openAdmin(page);
          await page.getByRole("button", { name: "AI 타자왕 디버그 시작", exact: true }).click();
          assert.equal(await page.locator(".admin-modal").count(), 0);
          assert.equal(await page.evaluate(() => (window as any).__readinessCalls), 2);
        } else {
          await page.getByText(outcome === "success" ? "프로필을 적용했습니다. 앱을 다시 시작합니다." : /적용 결과를 확인할 수 없습니다/).waitFor();
          for (const control of [start, close, home, debug, apply]) assert.equal(await control.isDisabled(), true, "success/unknown outcome stays locked until a fresh document");
          assert.equal(await page.evaluate(() => (window as any).__readinessCalls), readinessBeforeTransition);
        }
      }
      assert.deepEqual(errors, [], "handled IPC failure must not become an unhandled page error");
    });
  }
}
