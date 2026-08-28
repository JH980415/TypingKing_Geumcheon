import type { NasAdminActionV1, NasSessionV1 } from "../../shared/nas/protocol";
import type { RecordRow } from "../../shared/types";

export type AdminActionBase = {
  schema_version: 1;
  event_id: "geumcheon-science-festival-2026";
  action_id: string;
  created_at: string;
  session: NasSessionV1;
  admin_name: string;
};
export type AdminTransport = { postAdminAction(action: NasAdminActionV1): Promise<unknown> };

export class NasAdminSession {
  constructor(private readonly transport: AdminTransport) {}

  edit(base: AdminActionBase, targetRecordId: string, changes: Partial<RecordRow>): Promise<unknown> {
    if (Object.prototype.hasOwnProperty.call(changes, "record_id")) return Promise.reject(new Error("ADMIN_EDIT_FIELD_FORBIDDEN"));
    return this.transport.postAdminAction({ ...base, action_type: "edit", target_record_id: targetRecordId, changes } as NasAdminActionV1);
  }

  hide(base: AdminActionBase, targetRecordId: string, hidden: boolean): Promise<unknown> {
    return this.transport.postAdminAction({ ...base, action_type: "hide", target_record_id: targetRecordId, hidden } as NasAdminActionV1);
  }

  resetSession(base: AdminActionBase): Promise<unknown> {
    return this.transport.postAdminAction({ ...base, action_type: "reset_session" } as NasAdminActionV1);
  }
}
