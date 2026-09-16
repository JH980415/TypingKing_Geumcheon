# nas-record-api 클라이언트 시계 오차 허용 패치 (2026-09-17)

## 상태

- **배포하지 않았습니다.** 이 문서는 소스 수정 + 로컬 테스트 + 로컬 빌드까지의 기록이며, NAS의 어떤 파일도 변경하지 않았고 어떤 컨테이너도 재시작하지 않았습니다.
- **현재 운영 중인 서버(`typingking-record-api-test`)는 여전히 허용 오차 0(zero tolerance)** 으로 동작합니다. 즉, 클라이언트 PC 시계가 NAS 시계보다 POST 지연 시간 이상 앞서 있으면 그 PC의 모든 기록이 `COMPLETED_AT_INVALID`로 거부됩니다.
- 브랜치: `codex/typingking-v4-rental-20260912` (커밋하지 않음, 워킹 트리 변경만 존재)

## 무엇을, 왜 바꿨는가

### 문제

`src/recordSchema.ts`의 `validateTimestamps(row, receivedAt)`는 다음 조건이면 예외를 던졌습니다.

```ts
if (created > completed || completed > received || consent > completed) throw new Error("COMPLETED_AT_INVALID");
```

- `created_at`, `completed_at`, `privacy_agreed_at`은 **클라이언트 PC 시계**로 기록됩니다.
- `receivedAt`은 **NAS(서버) 시계**로 수신 시점에 찍힙니다.
- `completed > received`에 허용 오차가 전혀 없으므로, 클라이언트 PC 시계가 NAS보다 조금만 앞서 있어도(POST 지연보다 크면) 기록이 전부 거부됩니다.
- 현장은 외부 네트워크의 **렌탈 Windows PC 5대**입니다. 렌탈 PC의 시계 상태는 통제할 수 없고, 사무실 PC 기준으로도 NAS 시계가 약 0.2~1.3초 앞서는 것이 측정되었습니다. 방향이 반대인 PC(클라이언트가 앞서는 경우)가 한 대만 있어도 그 PC의 참가자 기록이 모두 사라집니다.

### 변경

`src/recordSchema.ts`

```ts
// Rental PC clocks may run ahead of the NAS clock; receivedAt stays the authoritative server timestamp.
const CLIENT_CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;
...
if (created > completed || completed > received + CLIENT_CLOCK_SKEW_TOLERANCE_MS || consent > completed) {
  throw new Error("COMPLETED_AT_INVALID");
}
```

- `completed_at`이 서버 수신 시각보다 **최대 5분**까지 앞서는 것을 허용합니다.
- `created > completed`, `consent > completed` 검사는 **그대로** 유지됩니다(행 내부의 순서 정합성은 변경 없음).
- 저장되는 `received_at`은 여전히 서버 시각이며, 순위/집계의 기준 시각으로서의 권위는 바뀌지 않습니다. 클라이언트가 보낸 `completed_at`은 정규화 없이 그대로 보존됩니다.
- 5분을 넘게 앞서는 `completed_at`은 여전히 `COMPLETED_AT_INVALID`로 거부됩니다.

변경된 파일(소스/테스트만, `git diff --stat`):

```
services/nas-record-api/src/recordSchema.ts       | 4 +++-
services/nas-record-api/test/recordSchema.test.ts | 9 +++++++++
```

## 테스트 증거 (TDD)

실행 위치: `services/nas-record-api`, 명령: `npm test` (`tsx --test ...`)

| 단계 | 결과 |
|---|---|
| 수정 전 기준선 | `tests 80 / pass 80 / fail 0` |
| RED: 테스트 추가 후 소스 수정 전 (`npx tsx --test test/recordSchema.test.ts`) | `tests 12 / pass 11 / fail 1` — 새 테스트가 `Error: COMPLETED_AT_INVALID`로 실패 (4분 앞선 `completed_at`이 거부됨을 확인) |
| GREEN: 소스 수정 후 전체 `npm test` | `tests 81 / pass 81 / fail 0 / cancelled 0 / skipped 0` |
| `npm run typecheck` (`tsc --noEmit`) | exit 0 |

추가된 테스트(`test/recordSchema.test.ts`): `tolerates a client clock ahead of the server by up to 5 minutes but keeps received_at authoritative`

- `RECEIVED_AT = 2026-08-26T03:10:00.000Z` 기준
- `completed_at = 03:14:00.000Z` (4분 앞섬) → 수락, `stored.row.completed_at`은 입력값 그대로, `stored.received_at`은 `RECEIVED_AT` 그대로
- `completed_at = 03:16:00.000Z` (6분 앞섬) → `/COMPLETED_AT_INVALID/`
- 기존 테스트 `validates phrase identity, timestamps, consent, phone and birth date`(`completed_at`이 `created_at`보다 이전인 케이스)는 그대로 통과

## 빌드 산출물

명령: `npm run build`
(`esbuild src/cli.ts --bundle --platform=node --target=node24 --format=cjs --packages=external --outfile=dist/server.cjs`)

| 항목 | 값 |
|---|---|
| 파일 | `services/nas-record-api/dist/server.cjs` |
| 크기 | **117,539 bytes** (esbuild 표기 114.8kb) |
| SHA-256 | **`5e1974d2c37384681fdfad31f2b1bbb13f30d0813368b8b24198ebd5ef5d8dc7`** |
| 해시 산출 | PowerShell `Get-FileHash -Algorithm SHA256` 와 `certutil -hashfile ... SHA256` 두 방법 결과 일치 |
| 번들 내 확인 | L682 `var CLIENT_CLOCK_SKEW_TOLERANCE_MS = 5 * 6e4;`, L802 `completed > received + CLIENT_CLOCK_SKEW_TOLERANCE_MS` |

주의: `--packages=external`이므로 번들은 `fastify` 등 의존성을 포함하지 않습니다. 컨테이너 안의 기존 `node_modules`를 그대로 사용하므로 `server.cjs` 한 파일만 교체하면 됩니다(의존성 버전은 변경하지 않았습니다).

## 수동 배포 절차 (NAS 관리자 권한 보유자용)

아래는 운영자가 직접 수행해야 하는 절차입니다. 자동화하지 않았고, 이 세션에서 실행하지 않았습니다.

### 0. 사전 확인

1. 대상 컨테이너: **`typingking-record-api-test`** 하나만 대상입니다. 다른 컨테이너는 건드리지 않습니다.
2. 런타임 경로: `/volume1/docker/typingking-runtime/uiv3-20260910-f528fa5/server/` 하위의 `server.cjs`. 실제 마운트 위치는 반드시 컨테이너 설정으로 확인합니다.
   - DSM Container Manager → 컨테이너 → `typingking-record-api-test` → 세부 정보 → 볼륨(마운트) 탭, 또는
   - SSH: `sudo docker inspect typingking-record-api-test --format '{{json .Mounts}}'`
3. 진행 중인 라운드/세션이 없는 시간대(참가자 입력이 없는 때)에 수행합니다. 재시작 중 수십 초간 API가 응답하지 않습니다.
4. 이 문서의 배포는 운영 승인 후에만 진행합니다.

### 1. 기존 파일 백업 (필수, 해시 기록)

```sh
cd /volume1/docker/typingking-runtime/uiv3-20260910-f528fa5/server/   # 실제 경로로 조정
sha256sum server.cjs                       # 기존(허용 오차 0) 번들의 해시를 이 문서/운영 로그에 기록
cp -p server.cjs server.cjs.bak-20260917   # 권한/시각 보존 복사
sha256sum server.cjs.bak-20260917          # 원본과 동일한지 확인
```

기존 파일의 SHA-256을 기록하기 전에는 다음 단계로 넘어가지 않습니다.

### 2. 새 번들 전송 및 무결성 확인

1. 로컬 `services/nas-record-api/dist/server.cjs`(117,539 bytes)를 File Station / SMB / scp 로 NAS의 임시 위치(예: 같은 폴더의 `server.cjs.new`)에 올립니다.
2. NAS에서 해시와 크기를 확인합니다.

```sh
sha256sum server.cjs.new    # 5e1974d2c37384681fdfad31f2b1bbb13f30d0813368b8b24198ebd5ef5d8dc7 이어야 함
stat -c %s server.cjs.new   # 117539 이어야 함
```

해시가 다르면 전송이 잘못된 것이므로 교체하지 않습니다.

### 3. 교체

```sh
chown --reference=server.cjs server.cjs.new
chmod --reference=server.cjs server.cjs.new
mv server.cjs.new server.cjs   # 같은 파일시스템 내 mv 이므로 원자적 교체
sha256sum server.cjs           # 다시 5e1974d2... 확인
```

### 4. 컨테이너 재시작 (해당 컨테이너만)

DSM Container Manager → 컨테이너 → `typingking-record-api-test` 선택 → 동작 → **재시작**.
프로젝트 전체나 다른 컨테이너는 재시작하지 않습니다. 재시작 후 로그 탭에서 리슨 로그가 정상 출력되는지 확인합니다.

### 5. 검증

1. 무인증 헬스체크

   ```
   GET /health
   기대: HTTP 200, {"status":"ok"}
   ```

   503 `{"status":"unavailable"}`이면 저장소/설정 준비 실패이므로 즉시 롤백(6단계)을 검토합니다.

2. 인증 준비 상태 확인 (토큰 값은 이 문서나 채팅에 기록하지 않습니다)

   ```
   GET /api/v1/ready?session_kind=practice&session_id=<운영 연습 세션 ID>
   헤더: Authorization: Bearer <writer 토큰>
         x-device-id: <해당 토큰의 device id>
   기대: HTTP 200, "status":"ready", event_id/device_id/role/session 이 요청과 일치
   ```

   공식 세션으로 확인할 때는 `session_kind=official&session_id=...&day_no=...&round_no=...` 네 개 쿼리를 모두 지정해야 합니다(그 외 키가 있으면 `SESSION_INVALID`).

3. (선택) 기능 검증: 연습 세션으로 테스트 PC에서 시계를 의도적으로 2~3분 앞당긴 뒤 기록 전송 → 이제는 200으로 수락되어야 합니다. 검증 후 테스트 PC 시계를 원복하고, 테스트용 기록은 운영 절차에 따라 정리합니다. 참가자 개인정보가 들어간 기록으로 시험하지 않습니다.

### 6. 롤백

```sh
cd /volume1/docker/typingking-runtime/uiv3-20260910-f528fa5/server/
cp -p server.cjs.bak-20260917 server.cjs
sha256sum server.cjs   # 1단계에서 기록한 기존 해시와 일치해야 함
```

그 뒤 4단계와 동일하게 `typingking-record-api-test`만 재시작하고 `GET /health`를 다시 확인합니다.

## 운영 시 참고

- 이 패치는 "클라이언트가 서버보다 앞서는" 방향만 5분까지 허용합니다. 클라이언트가 서버보다 **뒤처지는** 경우는 원래부터 거부 대상이 아니었으므로 변경이 없습니다.
- 렌탈 PC 시계가 5분 이상 앞서 있으면 여전히 거부됩니다. 현장 세팅 시 각 PC의 Windows 시간 동기화(`w32tm /resync`)를 한 번 수행하는 것을 권장하며, NAS 자체도 NTP 동기화가 켜져 있는지 확인합니다.
- 순위·집계에 쓰이는 `received_at`은 계속 서버 시각입니다. 이 패치로 서버 시각의 권위가 약해지지는 않습니다.
