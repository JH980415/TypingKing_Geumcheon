import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NasAdminActionV1 } from "../../../shared/nas/protocol.js";
import { RecordStore } from "../src/recordStore.js";
import { validateAndNormalizeRecord } from "../src/recordSchema.js";
import type { AuthenticatedPrincipal } from "../src/auth.js";
import {
  OFFICIAL_SESSION,
  RECEIVED_AT,
  envelope,
  recordRow,
  validationConfig,
} from "./fixtures.js";

const principal: AuthenticatedPrincipal = {
  tokenId: "PC01-write",
  deviceId: "PC01",
  eventId: "geumcheon-science-festival-2026",
  role: "writer",
  allowedSessions: ["official", "practice"],
};

function action(
  actionId: string,
  body:
    | { action_type: "edit"; target_record_id: string; changes: Record<string, string> }
    | { action_type: "hide"; target_record_id: string; hidden: boolean }
    | { action_type: "reset_session" },
): NasAdminActionV1 {
  return {
    schema_version: 1,
    event_id: "geumcheon-science-festival-2026",
    session: OFFICIAL_SESSION,
    action_id: actionId,
    created_at: "2026-08-26T03:11:00.000Z",
    admin_name: "운영자",
    ...body,
  } as NasAdminActionV1;
}

test("applies edit and hide actions to the view while preserving the original row JSON", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-admin-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new RecordStore({ dataRoot: root });
  const stored = validateAndNormalizeRecord(
    envelope(recordRow()),
    principal,
    validationConfig(root),
    RECEIVED_AT,
  );
  await store.put(stored);

  const edit = action(
    "gsc26-action-11111111-1111-4111-8111-111111111111",
    { action_type: "edit", target_record_id: stored.row.record_id, changes: { participant_name: "수정 이름" } },
  );
  assert.equal((await store.putAdminAction(edit)).disposition, "stored");
  assert.equal((await store.putAdminAction(edit)).disposition, "duplicate");

  let visible = await store.listEffective(OFFICIAL_SESSION);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].participant_name, "수정 이름");
  assert.equal(visible[0].phone_full, stored.row.phone_full);
  assert.equal(visible[0].is_admin_edited, "true");

  await store.putAdminAction(action(
    "gsc26-action-22222222-2222-4222-8222-222222222222",
    { action_type: "hide", target_record_id: stored.row.record_id, hidden: true },
  ));
  visible = await store.listEffective(OFFICIAL_SESSION);
  assert.deepEqual(visible, []);

  const original = await store.list(OFFICIAL_SESSION);
  assert.equal(original.length, 1);
  assert.equal(original[0].participant_name, stored.row.participant_name);
});

test("reset_session hides the session view without deleting source rows", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-reset-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new RecordStore({ dataRoot: root });
  const stored = validateAndNormalizeRecord(
    envelope(recordRow()),
    principal,
    validationConfig(root),
    RECEIVED_AT,
  );
  await store.put(stored);
  await store.putAdminAction(action(
    "gsc26-action-33333333-3333-4333-8333-333333333333",
    { action_type: "reset_session" },
  ));

  assert.deepEqual(await store.listEffective(OFFICIAL_SESSION), []);
  assert.equal((await store.list(OFFICIAL_SESSION)).length, 1);
});
