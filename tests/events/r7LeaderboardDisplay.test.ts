import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as leaderboard from "../../apps/leaderboard/src/LeaderboardApp";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
import { createBootstrapData } from "../../shared/events/bootstrapData";
import { loadEventProfile } from "../../shared/events/eventProfile";

test("Geumcheon public board defaults to count only and places its only logo before the search controls", () => {
  const html = renderToStaticMarkup(createElement(leaderboard.LeaderboardApp, {
    bootstrap: createBootstrapData({ config: DEFAULT_CONFIG, assetBaseUrl: "file:///resources/assets", notices: [], mode: "leaderboard", variant: "ai-leaderboard", eventProfile: loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json")) })
  }));
  assert.match(html, /현재 참여 기록 0건/);
  assert.doesNotMatch(html, /session-day|session-round/);
  const header = html.match(/<header class="leaderboard-header">[\s\S]*?<\/header>/)?.[0] ?? "";
  assert.match(header, /geumcheon-leaderboard-logo/);
  assert.ok(header.indexOf("geumcheon-leaderboard-logo") < header.indexOf("search-input"));
  assert.equal((html.match(/<img[^>]+ai_타자왕_금나래의_도전\.png/g) ?? []).length, 1);
});

test("day and round preference starts false, survives reload, and never shares values across variants", () => {
  assert.equal(typeof leaderboard.readLeaderboardDayRound, "function");
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(leaderboard.readLeaderboardDayRound(storage, "ai-leaderboard"), false);
  leaderboard.saveLeaderboardDayRound(storage, "ai-leaderboard", true);
  assert.equal(leaderboard.readLeaderboardDayRound(storage, "ai-leaderboard"), true);
  assert.equal(leaderboard.readLeaderboardDayRound(storage, "practice-leaderboard"), false);
  leaderboard.saveLeaderboardDayRound(storage, "ai-leaderboard", false);
  assert.equal(leaderboard.readLeaderboardDayRound(storage, "ai-leaderboard"), false);
});

test("unavailable or malformed display storage defaults off and failed saves report failure", () => {
  assert.equal(typeof leaderboard.readLeaderboardDayRound, "function");
  assert.equal(leaderboard.readLeaderboardDayRound({ getItem: () => "garbage" }, "ai-leaderboard"), false);
  assert.equal(leaderboard.readLeaderboardDayRound({ getItem: () => { throw new Error("blocked"); } }, "ai-leaderboard"), false);
  assert.throws(() => leaderboard.saveLeaderboardDayRound({ setItem: () => { throw new Error("disk full"); } }, "ai-leaderboard", true), /disk full/);
});

test("row selection switches rows, toggles repeated rows and clears on every outside target", () => {
  assert.equal(typeof leaderboard.resolveLeaderboardHighlight, "function");
  assert.equal(leaderboard.resolveLeaderboardHighlight("", "row-a"), "row-a");
  assert.equal(leaderboard.resolveLeaderboardHighlight("row-a", "row-b"), "row-b");
  assert.equal(leaderboard.resolveLeaderboardHighlight("row-a", "row-a"), "");
  assert.equal(leaderboard.resolveLeaderboardHighlight("row-a", null), "");
});

test("summary uses the supplied real aggregate and only shows configured day/round when enabled", () => {
  assert.equal(typeof leaderboard.SessionSummary, "function");
  const render = (showDayRound: boolean) => renderToStaticMarkup(createElement(leaderboard.SessionSummary, { config: { ...DEFAULT_CONFIG, dayNo: 2, roundNo: 3 }, participantCount: 17, geumcheon: true, showDayRound }));
  assert.match(render(false), /현재 참여 기록 17건/);
  assert.doesNotMatch(render(false), /2일차|3회차/);
  assert.match(render(true), /2일차/);
  assert.match(render(true), /3회차/);
});

const editableRecord = {
  record_id: "row-a", participant_name: "합성참여자", phone_part1: "010", phone_part2: "0000", phone_part3: "0001",
  birth_year: "2000", birth_month: "01", birth_day: "01", stage1_time_ms: "1000", stage2_time_ms: "2000", stage3_time_ms: "3000", memo: "saved", is_test: "false"
};

test("Geumcheon draft survives outside click, same-row reselect and same-row deselect", () => {
  let state = leaderboard.resolveLeaderboardRowClick({ selectedId: "", highlightedId: "", edit: null }, editableRecord, true);
  const draft = { ...state.edit!, memo: "unsaved draft" };
  state = { ...state, edit: draft, highlightedId: leaderboard.resolveLeaderboardHighlight(state.highlightedId, null) };
  state = leaderboard.resolveLeaderboardRowClick(state, editableRecord, true);
  assert.equal(state.highlightedId, "row-a");
  assert.equal(state.edit, draft);
  state = leaderboard.resolveLeaderboardRowClick(state, editableRecord, true);
  assert.equal(state.highlightedId, "");
  assert.equal(state.selectedId, "row-a");
  assert.equal(state.edit, draft);
});

test("Geumcheon can reopen the saved record after successful save clears its editor", () => {
  const afterSave = { selectedId: "row-a", highlightedId: "", edit: null };
  const reopened = leaderboard.resolveLeaderboardRowClick(afterSave, { ...editableRecord, memo: "new saved value" }, true);
  assert.equal(reopened.selectedId, "row-a");
  assert.equal(reopened.highlightedId, "row-a");
  assert.equal(reopened.edit?.memo, "new saved value");
});

test("another record replaces the editor while legacy same-row click still clears it", () => {
  const initial = leaderboard.resolveLeaderboardRowClick({ selectedId: "", highlightedId: "", edit: null }, editableRecord, true);
  const next = leaderboard.resolveLeaderboardRowClick(initial, { ...editableRecord, record_id: "row-b", memo: "other" }, true);
  assert.equal(next.selectedId, "row-b");
  assert.equal(next.highlightedId, "row-b");
  assert.equal(next.edit?.memo, "other");
  const legacy = leaderboard.resolveLeaderboardRowClick(initial, editableRecord, false);
  assert.equal(legacy.selectedId, "");
  assert.equal(legacy.edit, null);
});
