import assert from "node:assert/strict";
import test from "node:test";
import { listGeumcheonRecords } from "../../electron/geumcheonConnection";
import { buildRecordRow } from "../../shared/csv/fileStore";
import type { RecordRow } from "../../shared/types";

function row(id: string, name: string, phone: string): RecordRow {
  return { ...buildRecordRow({ participant_name: name, phone_part1: phone.slice(0, 3),
    phone_part2: phone.slice(3, 7), phone_part3: phone.slice(7), birth_year: "2000", birth_month: "1", birth_day: "1",
    privacy_agreed: true, privacy_agreed_at: "2026-09-10T00:00:00.000Z", stageTexts: ["가", "나", "다"], stageTimesMs: [1000, 1000, 1000] }),
    record_id: id };
}

const rows = [row("synthetic-001", "합성가나다", "01012345678"), row("synthetic-002", "합성다라마", "01099995678")];
const call = listGeumcheonRecords as (...args: any[]) => Promise<any>;
function options() {
  return { connection: { source: "production" as const, runtime: { loadRecords: async (_options?: unknown) => ({ rows }) } },
    role: "leaderboard" as const, eventProfileId: "geumcheon-2026", sessionKind: "official", readLegacy: () => { throw Error("legacy read forbidden"); } };
}

// Catch masked-text matching, prefix/exact-only matching, and numeric conversion losing the leading zero.
for (const [field, term, want] of [
  ["name", "성가", ["synthetic-001"]], ["name", "  가나다  ", ["synthetic-001"]],
  ["name", "다", ["synthetic-001", "synthetic-002"]], ["name", "가".repeat(300), []],
  ...["123", "1234", "0101", "0101234", "01012", "010-1234", "0 1 0-1"].map((term) => ["contact", term, ["synthetic-001"]]),
  ["contact", "56", ["synthetic-001", "synthetic-002"]], ["contact", "1", ["synthetic-001", "synthetic-002"]],
  ["contact", "5678", ["synthetic-001", "synthetic-002"]], ["contact", "8".repeat(300), []]
] as const) test(`protected full-string partial search ${field}/${term.length} derives the expected record IDs`, async () => {
  let loads = 0;
  const base = options();
  base.connection.runtime.loadRecords = async (readOptions) => { loads++; assert.deepEqual(readOptions, { freshOnly: true }); return { rows }; };
  const result = await call({ ...base, request: { search: { field, term } } });
  assert.deepEqual(result.matchingRecordIds, want);
  assert.equal(loads, 1);
  assert.deepEqual(result.rows, rows);
  assert.deepEqual(Object.keys(result).sort(), ["matchingRecordIds", "rows"]);
});

test("explicit cleared query returns an atomic full snapshot and only ID metadata", async () => {
  for (const search of [null, { field: "name", term: "  " }, { field: "contact", term: "\t " }]) {
    const result = await call({ ...options(), request: { search } });
    assert.deepEqual(result, { rows, matchingRecordIds: null });
  }
});

// Catch unauthorized source/session choice and invalid contacts silently becoming a full-list search.
for (const request of [null, [], {}, { search: undefined }, { search: {} }, { search: { field: "memo", term: "1" } },
  { search: { field: "name", term: 1 } }, { search: { field: "name", term: "1", raw: true } },
  { search: null, session: "practice" }, { search: null, deviceId: "PC01" }, { search: null, source: "review" },
  ...["abc", "1a2", "1.2", "*123", "---", "- -"].map((term) => ({ search: { field: "contact", term } }))]) {
  test("malformed protected search rejects before storage and never echoes input", async () => {
    const base = options(); let loads = 0;
    base.connection.runtime.loadRecords = async () => { loads++; return { rows }; };
    await assert.rejects(call({ ...base, request }), /^Error: RECORD_SEARCH_INVALID$/);
    assert.equal(loads, 0);
  });
}

for (const scope of [{ role: "player" }, { eventProfileId: "other-event" }, { sessionKind: "practice" }, { connection: null }]) {
  test("protected search requires current official Geumcheon leaderboard connection", async () => {
    await assert.rejects(call({ ...options(), ...scope, request: { search: null } }), /^Error: RECORD_SEARCH_UNAVAILABLE$/);
  });
}

test("query snapshot strips protected evidence and propagates real read failures", async () => {
  const base = options();
  base.connection.runtime.loadRecords = async () => ({ rows: [{ ...rows[0], recordEvidence: { hidden: "protected" } } as unknown as RecordRow] });
  const result = await call({ ...base, request: { search: { field: "contact", term: "1234" } } });
  assert.equal("recordEvidence" in result.rows[0], false);
  assert.deepEqual(result.matchingRecordIds, ["synthetic-001"]);
  base.connection.runtime.loadRecords = async () => { throw Error("NAS_CREDENTIAL_MISSING"); };
  await assert.rejects(call({ ...base, request: { search: null } }), /^Error: NAS_CREDENTIAL_MISSING$/);
});
