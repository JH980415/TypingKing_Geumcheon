# TypingKing R6 v2 NAS 운영 배포 안내

상태: 실제 NAS 배포 `NOT_RUN`, 운영 출시 `HOLD`. 이 묶음에는 실제 주소, 인증서, 토큰, HMAC 키가 없다. `__...__` 값을 모두 확정하기 전에는 시작 검증이 실패하도록 의도했다.

## PC 및 실행본 배치

- 리더보드 PC: `leaderboard_01.device-profile.json`을 실행 파일과 같은 폴더의 `device-profile.json`으로 복사하고 `ai-leaderboard` 운영 실행본을 사용한다.
- 플레이어 PC 1~4: 각각 `player_01`~`player_04.device-profile.json`을 해당 실행 파일과 같은 폴더의 `device-profile.json`으로 복사하고 `ai` 운영 실행본을 사용한다.
- 원본 이름은 인계용이다. 실행 시 인식하는 정확한 파일명은 항상 `device-profile.json`이다. 한 프로필을 여러 PC에 재사용하지 않는다.
- 운영 설정 디렉터리 권장값: Windows `%ProgramData%\TypingKing\Geumcheon2026\provisioning`(관리자와 실행 계정만 접근), NAS Linux `/volume1/docker/typingking-nas/config`(전용 서비스 UID 소유, 디렉터리 0700, 파일 0600). 서비스 계정이 보호 파일을 직접 읽어야 한다. 그 위 상위 디렉터리는 root 소유 0755처럼 서비스 UID가 통과할 수 있되 group/other 쓰기가 불가능하거나, 동일 서비스 UID 소유로 보호해야 한다. 실제 NAS 공유/볼륨 구조에 맞춰 최종 확정한다.

## 미확정 값 치환

다섯 프로필과 서버 템플릿에서 `__NAS_RECORD_API_URL__`, 공식/연습 세션 ID, 공식 일차/회차, 절대 경로, 토큰 만료시각을 확정한다. API 주소는 공인/사설 CA가 검증되는 `https://호스트[:포트]` 루트 주소만 허용하며 자격증명, query, fragment를 넣지 않는다. TLS 우회 환경변수나 인증서 검증 비활성화는 금지한다.

## 인증정보 생성 및 역할

각 장치마다 서로 다른 32바이트 난수 토큰을 오프라인 관리자 단말에서 생성한다. 평문 토큰은 해당 PC에만 전달하고 서버에는 SHA-256 해시만 `token-manifest`에 기록한다. PC01~PC04는 각 device ID에 묶인 `writer`, 리더보드는 `leaderboard`, 관리자 초기화/운영 기능은 같은 `LEADERBOARD01`에 묶인 별도 `operator` 토큰이다. 모두 공식·연습 세션 범위를 명시하며 행사 종료 뒤 만료/폐기한다.

클라이언트 최초 프로비저닝 파일은 실행 파일 옆 `bootstrap-credentials.json`이고 `{schemaVersion:1,eventId,deviceId,apiBaseUrl,token}`만 포함한다. 리더보드 관리자 토큰은 별도 `bootstrap-operator-credentials.json`에 같은 구조로 둔다. 앱이 OS 보안 저장소로 가져간 뒤 원본 부트스트랩 파일이 삭제됐는지 확인한다. 평문 토큰을 프로필, 로그, ZIP, 메신저에 넣지 않는다.

## 서버 설치와 재시작

1. NAS에 이 묶음의 `server`를 전용 서비스 계정 소유 디렉터리로 복사한다. 배포 전 저장소 원본에서 서버 테스트·타입검사·빌드를 완료한다. 묶음에는 검증된 `server/services/nas-record-api/dist/server.cjs`가 들어 있으므로 NAS에서 개발 빌드는 하지 않는다.
2. NAS에서 `cd /volume1/docker/typingking-nas/server/services/nas-record-api && npm ci --omit=dev`를 실행한다. 실제 설치 경로가 다르면 `/volume1/docker/typingking-nas`만 승인된 절대경로로 바꾼다. 잠금파일과 불일치하는 임의 업데이트를 하지 않는다.
3. `server/config` 템플릿을 보호된 실제 경로로 복사·치환하고, 32바이트 이상 HMAC 키와 stage-text CSV를 별도 파일로 둔다. 설정 디렉터리와 파일은 실제 실행하는 전용 서비스 UID가 소유하고 각각 0700/0600으로 제한한다. 상위 디렉터리는 서비스 UID가 통과 가능해야 하며 group/other 쓰기 권한과 심볼릭 링크는 허용하지 않는다.
4. `start-nas-record-api.sh.template`의 세 절대경로를 확정해 `start-nas-record-api.sh`로 저장하고 실행 권한을 부여한다. `__ABSOLUTE_NODE24_PATH__`는 NAS에서 `command -v node`와 `node --version`으로 확인한 Node 24 실행 파일의 절대경로여야 한다.
5. Synology DSM 작업 스케줄러에서 전용 비관리자 서비스 계정으로 **부팅 시 실행** 작업을 만들고 사용자 정의 스크립트에 `/bin/sh /volume1/docker/typingking-nas/server/config/start-nas-record-api.sh`를 입력한다. 서비스 루트가 다르면 확정된 절대경로를 사용한다. 수동 재시작은 작업 스케줄러에서 실행 중 작업을 중지한 뒤 다시 실행하며, 중복 프로세스를 띄우지 않는다.
6. 앱은 `NAS_BIND_HOST=127.0.0.1`, 기본 포트 `8787`로만 바인딩한다. 외부 공개는 Synology 역방향 프록시가 유효한 TLS 인증서로 HTTPS를 종료하고 `http://127.0.0.1:8787`로 전달하게 한다. NAS 방화벽에서 8787 직접 외부 접근을 열지 않는다.
7. 환경/권한이 잘못되면 서비스는 일반 오류 한 줄을 남기고 종료한다. 실패 시 반복 재시작보다 먼저 설정을 수정한다.

## 검증과 문제 해결

- 서버 로컬에서 readiness 응답, 역방향 프록시 HTTPS 인증서 체인/호스트명/TLS 1.2+, 다섯 장치의 역할별 접속을 확인한다.
- PC01~PC04 각각 저장 후 리더보드에 동일 세션 기록이 나타나는지 동시에 확인한다. 관리자 토큰으로만 초기화가 되고 writer/leaderboard 토큰은 403인지 확인한다.
- `AUTH_MISSING/INVALID/EXPIRED/REVOKED`: 평문 토큰, 만료, 폐기시각, 서버 해시를 점검한다.
- `DEVICE_SCOPE`: 프로필 device ID와 토큰 manifest device ID가 다른 상태다. 토큰을 공유하지 말고 올바른 쌍으로 다시 프로비저닝한다.
- `ROLE_SCOPE/SESSION_SCOPE`: 서버 manifest의 역할 또는 허용 세션과 실행본/프로필 세션이 다르다.
- `CONFIG_FILE_PERMISSION_INVALID`, `CONFIG_FILE_OWNER_INVALID`, `CONFIG_FILE_SUBSTITUTION`, `CONFIG_FILE_TRUST_UNVERIFIED`: 실제 파일/상위 디렉터리 소유권·권한·심볼릭 링크 여부를 바로잡는다. 보호 검사를 끄지 않는다.
- 연결 실패: 프로필 주소, DNS, 방화벽, NAS 역방향 프록시, 인증서 체인을 순서대로 확인한다. `NODE_TLS_REJECT_UNAUTHORIZED=0` 같은 우회는 사용하지 않는다.

실제 NAS 주소·인증서·계정/ACL·세션·보존기간·백업/복구 승인과 5대 동시 실행 증거가 없으므로 이 문서만으로 운영 PASS가 아니다.
