import type { NasRecordsSnapshotV1, NasSessionV1 } from "../../shared/nas/protocol";

export type RecordsTransport = { getRecords(session: NasSessionV1): Promise<NasRecordsSnapshotV1> };

export class NasLeaderboardClient {
  constructor(private readonly transport: RecordsTransport) {}
  load(session: NasSessionV1): Promise<NasRecordsSnapshotV1> {
    return this.transport.getRecords(session);
  }
}
