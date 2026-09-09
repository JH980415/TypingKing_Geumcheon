# R7 서버 실행 묶음과 NAS 적용 준비

상태: PRODUCTION_RELEASE=HOLD, 실제 NAS/Container Manager 적용 NOT_RUN. 이 문서는 적용 준비용이며 실행·설치 완료 보고가 아닙니다. NAS에 접속하거나 설정·권한을 변경하기 전 별도 승인이 필요합니다.

## 함께 사용할 배포본

R7_OFFICIAL_NAS_SERVER_RELEASE.zip은 공식 게임·리더보드 R7_OFFICIAL_NAS_CLIENT_RELEASE.zip과 같은 최종 소스에서 빌드한 서버 후보본입니다. 추가 기록 검증 계약이 있으므로 구서버와 새 클라이언트를 임의로 혼용하지 않습니다. 루트 SERVER_RELEASE_MANIFEST.json과 납품 R7_PACKAGE_MANIFEST.json의 소스 commit, 서버 파일·잠금파일·운영 의존성 버전 및 SHA-256을 대조합니다. 해시는 측정한 파일을 식별하며, 같은 소스에서 빌드했다는 판단은 별도 빌드 기록과 함께 확인합니다.

서버에는 dist/server.cjs, package.json, package-lock.json과 잠금파일에 명시된 운영 node_modules가 포함됩니다. 개발 도구·PC 인증정보·운영 데이터는 포함하지 않습니다. Node 24 실행 환경 자체는 포함하지 않으며, NAS CPU/Container Manager에서 지원하는 승인된 Node 24 이미지와 digest를 별도로 확정해야 합니다. 서버에서 npm install이나 개발 빌드를 할 것을 전제로 하지 않습니다.

## 기록 저장 위치 — 사용자 최신 지정

새 typingking 공유폴더를 만들지 않습니다. 기존 ‘임시’ 공유폴더 안의 ‘typingking’ 하위만 기록 저장소로 사용합니다. 사용자가 폴더 속성에서 실제 절대경로를 확인하기 전에는 볼륨 이름을 추측하지 않습니다. 임시 공유폴더 전체 또는 그 상위 경로를 마운트하지 않습니다.

| 용도 | NAS 호스트 경로 | 컨테이너 내부 경로 | 접근 |
|---|---|---|---|
| 기록 | __ABSOLUTE_CONFIRMED_TEMP_SHARE_TYPINGKING_DATA_PATH__ | /var/lib/typingking/records | 읽기/쓰기 |
| 서버 실행 묶음의 server 디렉터리 | __ABSOLUTE_CONFIRMED_SERVER_RUNTIME_PATH__ | /opt/typingking/server | 읽기 전용 |
| 보호 설정·토큰 해시·HMAC 키·문구 CSV | __ABSOLUTE_PROTECTED_TYPINGKING_SECRETS_PATH__ | /run/typingking-private | 읽기 전용 |

세 호스트 경로는 서로 같거나 부모·자식 관계가 되면 안 됩니다. 특히 비밀 설정과 키를 일반 공유 기록 폴더 내부에 넣지 않습니다. 실행 파일 위치나 비밀정보 위치는 사용자가 지정한 기록 위치에서 추론하지 않습니다. 심볼릭 링크·NAS 경로 별칭도 실제로 해석해 경로가 겹치지 않는지 적용 담당자가 확인합니다. 기존 공유폴더 또는 다른 폴더의 ACL은 변경하지 않습니다.

## Container Manager 검토 전용 후보

container/compose.review-only.template.yaml은 REVIEW_ONLY_NOT_APPLIED입니다. 기존 서버가 127.0.0.1:8787만 듣도록 제한하므로, host network는 이 제한을 보존하는 검토 후보로만 적었습니다. 대상 DSM/Container Manager 지원과 역방향 프록시 경로를 확인하고 별도 승인하기 전에는 운영 토폴로지로 채택하거나 실행하지 않습니다. ports 공개 설정은 없으며 0.0.0.0 바인딩 또는 TLS·인증 우회로 연결을 맞추지 않습니다. 8787은 현재 코드의 기본 내부 포트이며 확정된 외부 공개 포트가 아닙니다.

플레이스홀더는 검토본 복사본에서만 확정값으로 바꿉니다. 호스트 경로에는 공백·한글이 있을 수 있으므로 YAML 긴 형식 bind와 문자열 인용을 유지합니다. source에는 확인된 NAS 절대경로, target에는 표의 내부 경로를 입력합니다. 없는 호스트 폴더는 자동 생성하지 않도록 create_host_path=false를 유지합니다. UID/GID는 추측하지 않고 실제 서비스 계정을 확인합니다. 최소 권한·읽기 전용 루트·capability 제거 설정이 대상 환경에서 동작하는지는 실제 컨테이너로 별도 검증합니다.

## 적용 담당자의 확인 순서

1. 기존 기록·설정의 복구 가능한 백업과 승인된 적용 범위를 확인합니다. 기록 경로는 사용자가 확인한 임시/typingking 하위와 정확히 일치해야 합니다.
2. Node 24 이미지 digest·CPU 호환성·UID/GID·네트워크·HTTPS 역방향 프록시를 확정합니다. 전용 포트 개방이나 기존 공유폴더 ACL 변경은 이 문서로 승인되지 않습니다.
3. 보호 경로에 event-config.production.template.json과 token-manifest.production.template.json의 복사본을 실제 파일명으로 준비합니다. 공식 세션 ID와 양의 JSON 정수 일차/회차를 입력합니다. event config의 stageTextCatalogPath는 /run/typingking-private/stage_texts.csv로 설정하고 동봉 CSV를 그 보호 경로에 복사합니다. aiRanges.practice는 공용 스키마의 고정 필드이며 연습 세션 활성화를 뜻하지 않습니다.
4. 서로 다른 장치별 토큰과 HMAC 키는 별도 안전한 절차로 준비합니다. 서버에는 토큰 해시만 저장합니다. 비밀정보·키·실제 주소를 Git, 공개 ZIP, 채팅 또는 로그에 넣지 않습니다. 보호 디렉터리와 파일은 실제 전용 서비스 UID 소유의 0700/0600 등 현재 서버 보호 검증을 만족해야 하며 상위 경로의 통과 권한과 쓰기 금지도 확인합니다. 이 준비가 기존 임시 공유폴더 전체 ACL 변경을 허용하지 않습니다.
5. 승인 후에만 Container Manager 설정 검사와 실제 기동을 수행합니다. 마운트 경로 검증/YAML 파서 통과는 실제 컨테이너 기동·파일 권한·NAS 저장 증거가 아닙니다. 설정 누락 시 서버가 거절되는 보호를 유지합니다.
6. 공식 게임 1대와 리더보드로 실제 저장·조회·마스킹·순위·관리자 권한·재시작 보존을 확인한 후 물리 5대로 검증합니다. 원본 기록 보존과 초기화 범위도 별도 확인합니다. 검토용 기록을 운영 기록으로 이관하지 않습니다.

적용 실패 시 변경 전의 서버·클라이언트·설정 세트를 함께 복원할 준비를 유지합니다. 기존 원본 기록을 삭제하거나 새 계약 값으로 자동 변환하지 않습니다. 실제 NAS, Container Manager, 물리 5대 및 사용자 최종 승인 게이트가 끝나기 전 운영 출시 HOLD를 유지합니다.
