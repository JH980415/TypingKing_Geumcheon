import assert from "node:assert/strict";
import test from "node:test";
import { NasApiClient, type FetchLike } from "../../electron/nas/apiClient";
import { NasLeaderboardClient } from "../../electron/nas/leaderboardClient";

test("loads the authenticated full RecordRow snapshot for the selected session", async () => {
  let request: { input: string; init?: RequestInit } | undefined;
  const snapshot = {
    schema_version: 1,
    event_id: "geumcheon-science-festival-2026",
    session: { kind: "official", session_id: "official-1", day_no: 2, round_no: 3 },
    generated_at: "2026-09-19T01:00:00.000Z",
    rows: [{ record_id: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000", participant_name: "홍길동", phone_full: "01012345678", final_cpm: "700" }],
  };
  const fetch: FetchLike = async (input, init) => {
    request = { input: String(input), init };
    return new Response(JSON.stringify(snapshot), { status: 200, headers: { "content-type": "application/json" } });
  };
  const api = new NasApiClient({ baseUrl: "https://records.example.test", deviceId: "LEADERBOARD01", getToken: async () => "7".repeat(64), fetch, requestTimeoutMs: 1_000 });
  const client = new NasLeaderboardClient(api);

  const loaded = await client.load({ kind: "official", session_id: "official-1", day_no: 2, round_no: 3 });

  assert.equal(loaded.rows[0].participant_name, "홍길동");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), `Bearer ${"7".repeat(64)}`);
  assert.equal(request?.input, "https://records.example.test/api/v1/records?session_kind=official&session_id=official-1&day_no=2&round_no=3");
});

test("uses only practice query fields for a practice snapshot", async () => {
  let requested = "";
  const fetch: FetchLike = async (input) => {
    requested = String(input);
    return new Response(JSON.stringify({ schema_version: 1, event_id: "geumcheon-science-festival-2026", session: { kind: "practice", session_id: "practice-1" }, generated_at: "2026-09-19T01:00:00.000Z", rows: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const api = new NasApiClient({ baseUrl: "https://records.example.test", deviceId: "LEADERBOARD01", getToken: async () => "7".repeat(64), fetch, requestTimeoutMs: 1_000 });

  await new NasLeaderboardClient(api).load({ kind: "practice", session_id: "practice-1" });

  assert.equal(requested, "https://records.example.test/api/v1/records?session_kind=practice&session_id=practice-1");
});

