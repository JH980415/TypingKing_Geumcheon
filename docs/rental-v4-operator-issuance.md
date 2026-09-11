# 렌탈 v4 운영자 전용 일괄 발급 인계

이 도구는 권한 있는 기존 관리 환경에서만 실행합니다. 현장 PC에서는 공통 ZIP 전체 압축해제 → 해당 PC의 원래 이름 프로필 하나 배치 → EXE 더블클릭만 합니다.

## 준비와 승인 경계

- 실제 NAS에 접속하거나 서버 설정/키를 변경하지 않습니다. 기존 운영키를 새로 만들거나 교체하지 않습니다.
- 실제 발급 전 승인된 운영 시간, 사용 시작/만료, 서버 허용 회차와 기본 회차, 관리자 암호 담당자, 승인된 로컬 입력/출력 경로를 확정합니다.
- 기존 서버 event-config와 token-manifest의 로컬 승인 사본 및 대응하는 기존 원문 키 파일을 사용합니다. 서버 참가자 HMAC 키와 operator 원문 키는 필요하지 않습니다.
- PC01~04마다 기존 writer 1개 + leaderboard 1개, LEADERBOARD01은 leaderboard 1개: 총 9개의 서로 다른 원문 키가 필요합니다. 5프로필=5토큰으로 제한하지 않습니다.
- 각 선택 키는 manifest에서 동일 eventId/deviceId/role에 묶여 있어야 하고 allowedSessions는 정확히 ["official"], revokedAt은 null이어야 합니다. 프로필 만료는 모든 선택 키 만료 이내여야 합니다. read 권한이 없으면 실패하며 writer/operator로 대체하지 않습니다.
- 원문 키/관리자 암호/프로필은 채팅, Git, 공통 ZIP, OneDrive 등 동기화 경로에 넣지 않습니다. 실제 키 파일의 내용은 보고하지 않습니다.

## 운영자 실행

검증된 이 작업공간의 Node.js 및 기존 tsx 의존성을 재사용합니다. 현장 PC용 설치 작업이 아닙니다.

    node_modules\.bin\tsx.cmd scripts/rental-v4-issue-profiles.ts "승인된 로컬 요청파일 경로"

요청파일은 다음 필드를 가진 JSON입니다. 이 문서는 완성 프로필이나 실행 가능한 가짜 운영 입력이 아닙니다. 운영자는 승인된 로컬 관리 입력으로 요청을 구성하고, 현장 사용자에게 JSON 편집이나 토큰 복사를 시키지 않습니다.

| 필드 | 의미 |
|---|---|
| schemaVersion | 숫자 1 |
| stage | synthetic, test, production 중 승인된 용도 |
| deploymentId | 이번 발급 식별자, 1~100자 영문/숫자/점/밑줄/하이픈 |
| apiBaseUrl | 운영/실제 시험은 승인된 https://typingking.thepmd.synology.me, 합성은 HTTPS loopback |
| issuedAt / notBefore / expiresAt | ISO 8601 발급/사용 시작/만료. 미래 사용 시작은 발급 가능하나 EXE는 시작 전 거부 |
| defaultSessionId | 로컬 서버 event-config의 official 등록 회차 중 기본 sessionId |
| approvalReference | test/production은 승인 기록 식별자 필수. 키/암호를 쓰지 않음 |
| eventConfigPath | 기존 서버 설정 파일의 승인된 로컬 경로 |
| tokenManifestPath | 기존 서버 토큰 해시 manifest의 승인된 로컬 경로 |
| keys | 9개의 {tokenId, filePath}. filePath는 해당 기존 원문 키 파일 경로 |
| administratorPasswordFile | 승인된 담당자 관리자 암호 로컬 파일. 16~256자, 영문 대/소문자와 숫자 포함, 공통 기본암호 금지 |
| approvedOutputRoot | 승인된 기존 비공유 로컬 출력 부모 폴더 |
| outputDirectory | approvedOutputRoot 바로 아래의 아직 존재하지 않는 새 발급 폴더 |

로컬 입력 파일은 현재 운영자/SYSTEM/로컬 Administrators 외 읽기 허용이 있으면 거부합니다. 출력 폴더는 현재 운영자와 SYSTEM만 접근하는 보호 ACL을 적용한 뒤 파일을 씁니다. 네트워크 경로·네트워크 매핑 드라이브·알려진 동기화 폴더·Git 저장소·경로 링크는 거부합니다. 기존 출력 폴더는 덮어쓰지 않습니다.

실패시 원본 키/서버 설정을 유지합니다. 부분 발급 폴더를 성공 산출물로 쓰지 말고 오류 코드와 비밀 제거 receipt 여부만 확인합니다. 수정 후 승인된 새 출력 폴더에서 다시 발급합니다.

## 출력과 현장 전달

출력 폴더에는 아래 완성 프로필 5개, 같은 5개를 포함한 UIV3_OFFICIAL_DEVICE_PROFILES.zip, 비밀 없는 ISSUANCE_RECEIPT.json이 생깁니다. ZIP도 비밀 문서이므로 승인된 운영자 로컬 경로에서만 보관/전달합니다.

| 원래 파일명 | 물리 PC / 실행 |
|---|---|
| player_01.device-profile.json | PC01 게임+보드 |
| player_02.device-profile.json | PC02 게임+보드 |
| player_03.device-profile.json | PC03 게임+보드 |
| player_04.device-profile.json | PC04 게임+보드 |
| leaderboard_01.device-profile.json | LEADERBOARD01 보드만 |

프로필은 평문 JSON 비밀 문서입니다. Base64나 공통 내장키로 암호화했다고 주장하지 않습니다. EXE는 읽은 역할별 인증정보를 현장 Windows 보호 저장으로 가져옵니다. 관리자 암호는 프로필에 원문 대신 각 프로필별 난수 salt와 scrypt verifier로 들어갑니다.

receipt는 용도(SYNTHETIC/TEST/PRODUCTION), 파일명, 장치, 역할, 기간, 회차만 기록하며 원문 키/암호/verifier를 기록하지 않습니다. 정상 형태의 메타데이터에 비밀 문자열을 넣었더라도 알려진 키/암호/검증값을 포함하면 발급 자체를 거부합니다. 로컬 manifest SHA-256 대조는 실제 NAS 권한 성공의 증거가 아닙니다.

## 내부 타입 계약

scripts/rental-v4-issue-profiles.ts:

- buildRentalProfiles(input, {now?}) → {profiles:[{fileName,profile}], receipt}
- issueRentalProfiles({input,approvedOutputRoot,outputDirectory,now?}) → 보호 폴더/5프로필/프로필 ZIP/receipt
- issueRentalProfilesFromRequest(requestPath) → 승인된 로컬 파일 입력 경로
- 합성 시험은 in-memory keys:[{tokenId,token}], administratorPassword를 넣을 수 있습니다. 실제 운영자는 원문 값을 명령줄 인자로 전달하지 않습니다.

electron/deploymentProfile.ts의 parseDeploymentProfile을 발급과 EXE가 함께 사용합니다. profile envelope는 schemaVersion:2, deploymentId, issuedAt, notBefore, expiresAt, environment:test|production, device:DeviceProfile V1, allowedSessions:[{sessionId,dayNo,roundNo}], credentials:{leaderboard,writer?}, administrator:{algorithm:scrypt,salt,hash}입니다. credential은 eventId/deviceId/apiBaseUrl/role/token에 엄격히 바인딩합니다. administrator는 16바이트 salt의 32자리 소문자 hex와 scryptSync(password, saltBuffer, 64)의 128자리 소문자 hex hash입니다.

서버 manifest v1에는 notBefore 필드가 없습니다. 프로필의 notBefore는 EXE 사용 시작을 제한하며, 이를 서버가 키 사용 시작을 강제한다고 해석하면 안 됩니다. 현재 서버와 다른 manifest 필드를 임의로 추가하지 않습니다.

## 공통 클라이언트 생성

scripts/rental-v4-package-release.ts build는 최종 소스 커밋/무변경 상태 확인 후 같은 renderer/main 빌드에서 공식 EXE 2개를 생성합니다. 기존 builder 파일과 이전 EXE 경로는 보존하고 release-build/rental-v4로 출력합니다.

scripts/rental-v4-package-release.ts package "새 버전 납품 폴더"는 두 EXE, 공개 리소스 allowlist, 기존 release marker만 UIV3_OFFICIAL_NAS_CLIENT_RELEASE.zip에 넣습니다. 프로필/서버/발급기는 공통 ZIP에 들어가지 않습니다. source/build hashes와 실제 EXE 2개의 byte/hash binding, ZIP local/central header·CRC, 경로·중복·크기·파일별 SHA-256을 독립적으로 대조합니다. 최종 빌드에는 typingKingDeploymentProfileVersion=2를 명시합니다.

모든 단계에서 PRODUCTION_RELEASE=HOLD입니다. 새 최종 EXE의 승인된 실제 NAS 저장 및 다섯 보드 통합 조회와 최종 사용자 승인 전에는 해제하지 않습니다.
