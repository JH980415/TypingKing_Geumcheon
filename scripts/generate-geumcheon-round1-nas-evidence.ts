import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildNasApp } from "../services/nas-record-api/src/app.js";
import { RecordStore } from "../services/nas-record-api/src/recordStore.js";
import {
  OFFICIAL_SESSION,
  PRACTICE_SESSION,
  RECEIVED_AT,
  envelope,
  headers,
  recordRow,
  tokenManifest,
  validationConfig,
} from "../services/nas-record-api/test/fixtures.js";

const OFFICIAL_RECORD_ID = "gsc26-pc01-11111111-1111-4111-8111-111111111111";
const PRACTICE_RECORD_ID = "gsc26-pc01-22222222-2222-4222-8222-222222222222";

type RecordResult = {
  firstStatus: number;
  retryStatus: number;
  retryDisposition: string;
  conflictStatus: number;
};

export type GeumcheonRound1NasEvidenceSummary = {
  schemaVersion: 1;
  evidenceKind: "synthetic-local-mock";
  generatedAt: string;
  dataRoot: string;
  official: RecordResult;
  practice: RecordResult;
  leaderboard: { officialRows: number; practiceRows: number };
  files: {
    sourceJson: string[];
    copiedJson: string[];
    pathInventory: string;
  };
};

export async function generateGeumcheonRound1NasEvidence(options: {
  outputRoot: string;
}): Promise<GeumcheonRound1NasEvidenceSummary> {
  const outputRoot = path.resolve(options.outputRoot);
  const dataRoot = path.join(outputRoot, "mock-nas-data");
  const copiesRoot = path.join(outputRoot, "json-copies");

  await mkdir(outputRoot, { recursive: true });
  await Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(copiesRoot, { recursive: true, force: true }),
    rm(path.join(outputRoot, "path-inventory.json"), { force: true }),
    rm(path.join(outputRoot, "summary.json"), { force: true }),
    rm(path.join(outputRoot, "report.md"), { force: true }),
  ]);

  const syntheticPhone = {
    phone_part1: "010",
    phone_part2: "0000",
    phone_part3: "0000",
    phone_full: "010-0000-0000",
    phone_masked: "010-0000-0000",
  };
  const officialRow = recordRow({
    ...syntheticPhone,
    record_id: OFFICIAL_RECORD_ID,
    participant_name: "합성 공식 참가자",
  });
  const practiceRow = recordRow({
    ...syntheticPhone,
    record_id: PRACTICE_RECORD_ID,
    participant_name: "합성 연습 참가자",
    ai_stage1_cpm: "100",
    ai_stage2_cpm: "150",
    ai_stage3_cpm: "200",
  });

  const store = new RecordStore({ dataRoot });
  const app = buildNasApp({
    config: { ...validationConfig(dataRoot), tokenManifest: tokenManifest() },
    recordStore: store,
    now: () => RECEIVED_AT,
  });

  let official: RecordResult;
  let practice: RecordResult;
  let officialRows = 0;
  let practiceRows = 0;
  try {
    official = await verifyRecordFlow(app, envelope(officialRow, OFFICIAL_SESSION), OFFICIAL_RECORD_ID);
    practice = await verifyRecordFlow(app, envelope(practiceRow, PRACTICE_SESSION), PRACTICE_RECORD_ID);

    assert.equal((await store.list(OFFICIAL_SESSION)).length, 1);
    assert.equal((await store.list(PRACTICE_SESSION)).length, 1);

    const officialSnapshot = await app.inject({
      method: "GET",
      url: "/api/v1/records?session_kind=official&session_id=official-day1-round1&day_no=1&round_no=1",
      headers: headers("leaderboard"),
    });
    const practiceSnapshot = await app.inject({
      method: "GET",
      url: "/api/v1/records?session_kind=practice&session_id=practice-2026",
      headers: headers("leaderboard"),
    });
    assert.equal(officialSnapshot.statusCode, 200, officialSnapshot.body);
    assert.equal(practiceSnapshot.statusCode, 200, practiceSnapshot.body);
    const officialPayload = officialSnapshot.json<{ rows: Array<{ record_id: string }> }>();
    const practicePayload = practiceSnapshot.json<{ rows: Array<{ record_id: string }> }>();
    assert.deepEqual(officialPayload.rows.map((row) => row.record_id), [OFFICIAL_RECORD_ID]);
    assert.deepEqual(practicePayload.rows.map((row) => row.record_id), [PRACTICE_RECORD_ID]);
    officialRows = officialPayload.rows.length;
    practiceRows = practicePayload.rows.length;
  } finally {
    await app.close();
  }

  const officialSource = path.join(
    dataRoot,
    "기록저장",
    "1일차",
    "1회차",
    "incoming",
    "ai",
    `${OFFICIAL_RECORD_ID}.json`,
  );
  const practiceSource = path.join(
    dataRoot,
    "기록저장",
    "연습회차",
    "incoming",
    "ai",
    `${PRACTICE_RECORD_ID}.json`,
  );
  const officialBytes = await readFile(officialSource);
  const practiceBytes = await readFile(practiceSource);
  assert.equal(JSON.parse(officialBytes.toString("utf8")).record_id, OFFICIAL_RECORD_ID);
  assert.equal(JSON.parse(practiceBytes.toString("utf8")).record_id, PRACTICE_RECORD_ID);

  await mkdir(copiesRoot, { recursive: true });
  const officialCopy = path.join(copiesRoot, "official-record.json");
  const practiceCopy = path.join(copiesRoot, "practice-record.json");
  await Promise.all([
    copyFile(officialSource, officialCopy),
    copyFile(practiceSource, practiceCopy),
  ]);
  assert.deepEqual(await readFile(officialCopy), officialBytes);
  assert.deepEqual(await readFile(practiceCopy), practiceBytes);

  const relative = (target: string) => path.relative(outputRoot, target);
  const sourceJson = [relative(officialSource), relative(practiceSource)];
  const copiedJson = [relative(officialCopy), relative(practiceCopy)];
  const pathInventory = "path-inventory.json";
  await writeFile(path.join(outputRoot, pathInventory), `${JSON.stringify([
    {
      session: "official",
      source: sourceJson[0],
      copy: copiedJson[0],
      contentSha256: createHash("sha256").update(officialBytes).digest("hex"),
    },
    {
      session: "practice",
      source: sourceJson[1],
      copy: copiedJson[1],
      contentSha256: createHash("sha256").update(practiceBytes).digest("hex"),
    },
  ], null, 2)}\n`, "utf8");

  const summary: GeumcheonRound1NasEvidenceSummary = {
    schemaVersion: 1,
    evidenceKind: "synthetic-local-mock",
    generatedAt: RECEIVED_AT,
    dataRoot: relative(dataRoot),
    official,
    practice,
    leaderboard: { officialRows, practiceRows },
    files: { sourceJson, copiedJson, pathInventory },
  };

  const report = [
    "# 금천 1회차 검토용 합성 NAS JSON 증거",
    "",
    "- 테스트 환경: 실제 운영망과 분리된 로컬 Mock NAS",
    "- 참가자 연락처: 010-0000-0000 (합성 고정값)",
    `- 공식 기록: 최초 저장 ${official.firstStatus}, 동일 기록 재전송 ${official.retryStatus} (${official.retryDisposition}), 변경 충돌 ${official.conflictStatus}`,
    `- 연습 기록: 최초 저장 ${practice.firstStatus}, 동일 기록 재전송 ${practice.retryStatus} (${practice.retryDisposition}), 변경 충돌 ${practice.conflictStatus}`,
    `- 리더보드 조회: 공식 ${officialRows}건, 연습 ${practiceRows}건`,
    "",
    "## 저장 경로",
    "",
    ...sourceJson.map((item) => `- ${item}`),
    "",
    "운영 인증정보와 실제 NAS 주소는 사용하거나 기록하지 않았습니다.",
  ].join("\n");
  await Promise.all([
    writeFile(path.join(outputRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
    writeFile(path.join(outputRoot, "report.md"), `${report}\n`, "utf8"),
  ]);
  return summary;
}

async function verifyRecordFlow(
  app: ReturnType<typeof buildNasApp>,
  payload: ReturnType<typeof envelope>,
  recordId: string,
): Promise<RecordResult> {
  const request = (body: ReturnType<typeof envelope>) => app.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: headers("writer", { "idempotency-key": recordId }),
    payload: body,
  });
  const first = await request(payload);
  const retry = await request(payload);
  const conflictPayload = {
    ...payload,
    row: { ...payload.row, participant_name: "합성 충돌 참가자" },
  };
  const conflict = await request(conflictPayload);
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().disposition, "stored");
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().disposition, "duplicate");
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().code, "IDEMPOTENCY_CONFLICT");
  return {
    firstStatus: first.statusCode,
    retryStatus: retry.statusCode,
    retryDisposition: retry.json().disposition,
    conflictStatus: conflict.statusCode,
  };
}

if (require.main === module) {
  generateGeumcheonRound1NasEvidence({
    outputRoot: path.resolve("test_artifacts", "geumcheon_round1", "nas-json-evidence"),
  }).catch(() => {
    process.stderr.write("Synthetic NAS evidence generation failed.\n");
    process.exitCode = 1;
  });
}
