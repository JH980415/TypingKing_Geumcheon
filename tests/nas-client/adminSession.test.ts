import assert from "node:assert/strict";
import test from "node:test";
import { NasAdminSession, type AdminActionBase, type AdminTransport } from "../../electron/nas/adminSession";
import type { RecordRow } from "../../shared/types";

const base: AdminActionBase = {
  schema_version: 1,
  event_id: "geumcheon-science-festival-2026",
  action_id: "gsc26-action-123e4567-e89b-42d3-a456-426614174000",
  created_at: "2026-09-19T01:00:00.000Z",
  session: { kind: "official", session_id: "official-1", day_no: 1, round_no: 1 },
  admin_name: "운영자",
};
const recordId = "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000";

test("sends edit, hide, and reset_session as explicit authenticated admin actions", async () => {
  const actions: unknown[] = [];
  const transport: AdminTransport = { postAdminAction: async (action) => { actions.push(action); return { ok: true }; } };
  const session = new NasAdminSession(transport);

  await session.edit(base, recordId, { participant_name: "수정 이름" } as Partial<RecordRow>);
  await session.hide(base, recordId, true);
  await session.resetSession(base);

  assert.deepEqual(actions, [
    { ...base, action_type: "edit", target_record_id: recordId, changes: { participant_name: "수정 이름" } },
    { ...base, action_type: "hide", target_record_id: recordId, hidden: true },
    { ...base, action_type: "reset_session" },
  ]);
});

test("rejects edits to immutable identity and session fields before network transmission", async () => {
  let calls = 0;
  const session = new NasAdminSession({ postAdminAction: async () => { calls += 1; return { ok: true }; } });

  await assert.rejects(() => session.edit(base, recordId, { record_id: "changed" } as Partial<RecordRow>), /ADMIN_EDIT_FIELD_FORBIDDEN/);
  assert.equal(calls, 0);
});
