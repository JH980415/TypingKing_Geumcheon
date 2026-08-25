# 타자왕 최종 OneDrive·중단 기록 검수 보고서

- 작성일: 2026-08-05
- 최종 판정: 실제 행사 PC 리허설을 전제로 배포 가능
- 배포 위치: `release`

## 1. 요청 반영 결과

### 게임 중 메인/다시하기 기록

- 일반 타자왕은 누른 시점까지의 시간, 입력 글자 수, 타수, 정확도, 스테이지와 진행률을 `중단` 기록으로 저장한다.
- AI 타자왕은 같은 정보를 `중단 패배` 및 `AI_WIN`으로 저장하되, 실제 중단 시점의 사용자·AI 진행률을 보존한다.
- 저장 중 버튼을 다시 누를 수 없으며, OneDrive 저장 실패 시 각 PC의 로컬 누락 기록 폴더에 보존한다.
- 완료 기록은 중단 기록보다 항상 먼저 정렬된다. 중단 기록끼리는 스테이지, 진행률, 타수 순으로 비교한다.

### OneDrive 용량·충돌 개선

- 참여 기록은 계속 `1기록 = 고유 JSON 1파일`로 저장한다. 여러 PC가 하나의 master 파일을 덮어쓰지 않는다.
- 리더보드는 기록·관리자 조치 폴더를 읽기만 하며, 자동 새로고침 때 heartbeat나 공유 로그를 쓰지 않는다.
- 회차·문구 동기화는 무한히 파일을 쌓지 않고 `_typingking_state` 아래 PC별 고정 스냅샷 1개를 교체한다.
- CSV 백업 표식은 수천 개의 record_id 목록 대신 기록 수와 SHA-256 해시만 보관한다.
- 기록 폴더가 바뀌지 않으면 디렉터리 캐시를 사용하여 리더보드 6대가 4천 파일을 매번 다시 읽지 않는다.
- 기존 구버전 신호·공유 로그·임시 파일은 관리자 화면의 `OneDrive 불필요 파일 정리`로 한 번 정리할 수 있다.
- 정리 기능은 `incoming`, `admin_actions`, `exports` 및 원본 참여 기록을 삭제하지 않는다.

### `파일명-DESKTOP...` 충돌 복사본 방지

- 배포 EXE 옆의 공용 `config`, `data`, `logs`를 실행 중 저장소로 사용하지 않는다.
- 각 PC의 설정, 로컬 누락 기록, 복구 파일과 로그는 `%LOCALAPPDATA%\ThePMD\TypingKing2026`에 저장한다.
- 기존 실행 폴더에 설정·누락 기록이 있으면 첫 실행 시 로컬 저장소로 복사하되 원본은 삭제하지 않는다.
- 따라서 release 폴더를 OneDrive에 두더라도 여러 PC가 같은 config/data/log 파일을 수정하지 않는다.

## 2. 추가 수정

- AI 최종 결과 화면에서 로봇과 요약 카드가 버튼을 밀어내던 문제를 수정했다.
- 1366×768, 1600×900, FHD, QHD, 3440×1440에서 결과 버튼까지 화면 안에 표시된다.
- Electron 창의 새 창 열기와 예상하지 않은 외부 주소 이동을 차단했다.
- Electron을 43.3.0으로 갱신하고 `npm audit` 취약점 0건을 확인했다.
- 빌드 설정을 수정해 코드 서명은 생략하되 EXE 아이콘·제품명·버전 리소스는 적용한다.

## 3. 자동 테스트 결과

| 테스트 | 결과 | 근거 |
| --- | --- | --- |
| `npm ci` | PASS | 383개 패키지 설치, 취약점 0 |
| `npm run build` | PASS | Vite 및 Electron TypeScript 빌드 성공 |
| `npm run test:logic` | PASS | 중단/완료 순위 포함 |
| `npm run test:e2e:multi-pc` | PASS | 41개 통과, 실패 0 |
| `npm run test:e2e:large-session` | PASS | 4,000건, 리더보드 6개, 공유 쓰기 증가 0 |
| `npm run test:e2e:interruption` | PASS | 일반/AI × 메인/다시하기 4개 통과 |
| `npm run test:e2e:ui` | PASS | 리더보드·관리자 102개 화면, 실패 0 |
| `npm run test:e2e:play-ui` | PASS | 플레이·결과 77개 화면, 실패 0 |
| `npm run dist` | PASS | Electron 43.3.0 기반 EXE 6개 생성 |
| `npm run test:e2e:packaged` | PASS | 실제 EXE 6개 실행, 제목·역할·AppData·이미지 확인 |
| `npm run clean:release` | PASS | 배포 CSV 헤더만 유지 |
| `npm run scan:pii` | PASS | release 및 ZIP 개인정보 의심 문자열 없음 |

4천 건 성능 측정 결과:

- 6개 리더보드 최초 전체 읽기: 1.946초
- 캐시 상태에서 6개 리더보드 × 10회 읽기: 0.395초
- 공유 파일 수: 읽기 전 4,007개 / 읽기 후 4,007개
- 공유 로그: 0개, 임시 `.tmp`: 0개
- 기록 JSON 총용량: 약 6.75MB, 평균 약 1.73KB
- 테스트 프로세스 heap 사용량: 약 51MB

## 4. 최종 EXE

1. `일잘러 타자왕은 누구.exe`
2. `AI 타자왕을 이겨라.exe`
3. `일잘러 타자왕은 누구_리더보드.exe`
4. `AI 타자왕을 이겨라_리더보드.exe`
5. `타자왕 연습모드.exe`
6. `타자왕 연습모드_리더보드.exe`

실제 배포 EXE 6개에서 창 제목, 게임/리더보드 역할, 이미지 로딩, PC별 AppData 생성과 release 템플릿 무변경을 확인했다. 플레이용과 리더보드용 아이콘 리소스도 각각 추출해 확인했다.

## 5. 현장 적용 순서

1. 모든 PC의 프로그램을 새 `release`로 동시에 교체한다.
2. 각 PC에서 관리자 설정을 열어 PC ID와 OneDrive 루트를 확인한다.
3. 공식 회차 폴더 생성 및 검증을 실행한다.
4. 모든 PC가 새 버전임을 확인한 뒤 관리자 화면의 `OneDrive 불필요 파일 정리`를 한 번 실행한다.
5. 플레이 PC 1대에서 일반 중단, AI 중단, 일반 완료, AI 완료를 각각 만들고 두 리더보드 PC에서 확인한다.
6. 리더보드 PC 6대를 사용하는 경우 같은 기록 수와 순위를 표시하는지 확인한다.
7. 회차 종료 전 일반·AI CSV를 각각 내보낸다.

## 6. 남은 실기 확인

- 실제 OneDrive 클라이언트 2대 이상에서의 업로드·다운로드 지연은 1PC 시뮬레이션으로 완전히 재현할 수 없다.
- 실제 Windows 배율 125%·150%, TV 연결, 작업표시줄 아이콘은 행사 장비에서 최종 육안 확인이 필요하다.
- 실행 파일은 코드 서명 인증서가 없으므로 Windows SmartScreen 경고가 나올 수 있다. 아이콘과 제품 정보는 정상 적용됐다.
- 구버전 PC가 남아 있으면 다시 구버전 공유 로그·신호 파일을 만들 수 있으므로 반드시 전 PC를 함께 교체해야 한다.

## 7. 테스트 증거

- `test_artifacts/e2e_4pc/report.md`
- `test_artifacts/large_session_4000/summary.json`
- `test_artifacts/interruption_e2e/summary.json`
- `test_artifacts/ui_screenshots/report_ui_overflow.md`
- `test_artifacts/play_flow_screenshots/report_play_flow_overflow.md`
- `test_artifacts/packaged_runtime/summary.json`
