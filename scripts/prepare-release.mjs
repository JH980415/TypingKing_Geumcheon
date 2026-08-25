import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { stringify } from "csv-stringify/sync";

const root = process.cwd();
const release = path.join(root, "release");
const headers = {
  records: [
    "record_id",
    "created_at",
    "completed_at",
    "participant_name",
    "phone_part1",
    "phone_part2",
    "phone_part3",
    "phone_full",
    "phone_masked",
    "birth_year",
    "birth_month",
    "birth_day",
    "birthdate",
    "birthdate_masked",
    "privacy_agreed",
    "privacy_agreed_at",
    "stage1_text",
    "stage2_text",
    "stage3_text",
    "stage1_char_count",
    "stage2_char_count",
    "stage3_char_count",
    "total_char_count",
    "stage1_time_ms",
    "stage2_time_ms",
    "stage3_time_ms",
    "stage1_cumulative_ms",
    "stage2_cumulative_ms",
    "total_time_ms",
    "display_stage1_sec",
    "display_stage2_sec",
    "display_stage3_sec",
    "display_total_sec",
    "final_cpm",
    "final_accuracy",
    "app_version",
    "is_test",
    "is_debug",
    "debug_mode_type",
    "memo",
    "game_mode",
    "ai_enabled",
    "ai_challenge_status",
    "ai_failed_stage",
    "ai_stage1_cpm",
    "ai_stage2_cpm",
    "ai_stage3_cpm",
    "ai_stage1_time_ms",
    "ai_stage2_time_ms",
    "ai_stage3_time_ms",
    "ai_total_time_ms",
    "stage1_vs_ai_result",
    "stage2_vs_ai_result",
    "stage3_vs_ai_result",
    "final_vs_ai_result",
    "stage1_time_diff_ms",
    "stage2_time_diff_ms",
    "stage3_time_diff_ms",
    "final_time_diff_ms",
    "participant_result_time_ms",
    "ai_result_time_ms",
    "participant_avg_cpm",
    "ai_avg_cpm",
    "challenge_result_label",
    "participant_progress_percent",
    "ai_progress_percent",
    "duel_time_ms",
    "result_stage",
    "original_record_id",
    "is_admin_edited"
  ],
  stages: ["id", "game_mode", "stage_number", "text", "is_active", "created_at", "updated_at"],
  audit: ["audit_id", "action_type", "target_record_id", "before_value", "after_value", "admin_name", "created_at"]
};

const headerLabels = {
  record_id: "기록ID",
  created_at: "생성일시",
  completed_at: "완료일시",
  participant_name: "참여자명",
  phone_part1: "휴대폰앞자리",
  phone_part2: "휴대폰가운데자리",
  phone_part3: "휴대폰끝자리",
  phone_full: "휴대폰번호",
  phone_masked: "휴대폰번호마스킹",
  birth_year: "출생연도",
  birth_month: "출생월",
  birth_day: "출생일",
  birthdate: "생년월일",
  birthdate_masked: "생년월일마스킹",
  privacy_agreed: "개인정보동의",
  privacy_agreed_at: "개인정보동의일시",
  stage1_text: "1단계문구",
  stage2_text: "2단계문구",
  stage3_text: "3단계문구",
  stage1_char_count: "1단계글자수",
  stage2_char_count: "2단계글자수",
  stage3_char_count: "3단계글자수",
  total_char_count: "전체글자수",
  stage1_time_ms: "1단계시간ms",
  stage2_time_ms: "2단계시간ms",
  stage3_time_ms: "3단계시간ms",
  stage1_cumulative_ms: "1단계누적ms",
  stage2_cumulative_ms: "2단계누적ms",
  total_time_ms: "전체시간ms",
  display_stage1_sec: "1단계표시초",
  display_stage2_sec: "2단계표시초",
  display_stage3_sec: "3단계표시초",
  display_total_sec: "전체표시초",
  final_cpm: "최종타수",
  final_accuracy: "최종정확도",
  app_version: "앱버전",
  is_test: "테스트기록",
  is_debug: "디버그기록",
  debug_mode_type: "디버그모드유형",
  memo: "메모",
  game_mode: "게임모드",
  ai_enabled: "AI사용여부",
  ai_challenge_status: "AI챌린지상태",
  ai_failed_stage: "AI패배스테이지",
  ai_stage1_cpm: "AI1단계타수",
  ai_stage2_cpm: "AI2단계타수",
  ai_stage3_cpm: "AI3단계타수",
  ai_stage1_time_ms: "AI1단계시간ms",
  ai_stage2_time_ms: "AI2단계시간ms",
  ai_stage3_time_ms: "AI3단계시간ms",
  ai_total_time_ms: "AI전체시간ms",
  stage1_vs_ai_result: "1단계AI대결결과",
  stage2_vs_ai_result: "2단계AI대결결과",
  stage3_vs_ai_result: "3단계AI대결결과",
  final_vs_ai_result: "최종AI대결결과",
  stage1_time_diff_ms: "1단계시간차ms",
  stage2_time_diff_ms: "2단계시간차ms",
  stage3_time_diff_ms: "3단계시간차ms",
  final_time_diff_ms: "최종시간차ms",
  participant_result_time_ms: "참여자표시기록ms",
  ai_result_time_ms: "AI표시기록ms",
  participant_avg_cpm: "참여자평균타수",
  ai_avg_cpm: "AI평균타수",
  challenge_result_label: "AI타자왕결과",
  participant_progress_percent: "참여자점수진행률",
  ai_progress_percent: "AI점수진행률",
  duel_time_ms: "대결시간ms",
  result_stage: "종료스테이지",
  original_record_id: "원본기록ID",
  is_admin_edited: "관리자수정여부",
  id: "문구ID",
  stage_number: "스테이지",
  text: "문구",
  is_active: "활성여부",
  updated_at: "수정일시",
  audit_id: "감사ID",
  action_type: "작업유형",
  target_record_id: "대상기록ID",
  before_value: "변경전값",
  after_value: "변경후값",
  admin_name: "관리자명"
};

const defaultStageTextsByStage = [
  [
    "일잘러는 빠르게 움직입니다.\n하지만 정확함을 놓치지 않습니다!",
    "오늘의 업무는 오늘 끝냅니다.\n이것이 일잘러의 기본입니다!",
    "일의 본질을 다시 묻습니다.\n더 나은 방식을 선택하세요!",
    "빠른 입력은 좋은 출발입니다.\n정확한 마무리가 진짜 실력입니다!",
    "복잡한 업무도 정리하면 쉬워집니다.\n핵심부터 입력하세요!",
    "성장은 작은 변화에서 시작됩니다.\n오늘의 습관을 바꿔보세요!",
    "좋은 일처리는 속도만으로 완성되지 않습니다.\n정확도가 필요합니다!",
    "일잘러의 무기는 집중력입니다.\n끝까지 흔들리지 마세요!"
  ],
  [
    "빠른 사람은 많지만 끝까지 정확한 사람은 적습니다.\n100점 입력은 작은 실수까지 보는 힘입니다.\n도전해 보세요!",
    "회의가 끝난 뒤 5분 안에 정리해야 합니다.\n결정사항과 담당자를 남겨야 합니다.\n기록이 다음 행동을 만듭니다!",
    "일잘러는 10개의 일을 동시에 붙잡지 않습니다.\n중요한 일부터 순서를 정합니다.\n그래서 결과가 달라집니다!",
    "2026 일잘러 페스타는 일하는 방식을 다시 묻습니다.\n변화는 작은 선택 1개에서 시작됩니다.\n지금 정확하게 입력하세요!",
    "전시장에서 만나는 7개 품목은 일의 변화를 보여줍니다.\n도구를 이해하면 업무 방식도 달라집니다.\n지금 집중하세요!",
    "일잘러는 문장 1개도 대충 넘기지 않습니다.\n띄어쓰기와 기호까지 확인합니다.\n마지막 글자까지 완성하세요!"
  ],
  [
    "Work Redesign은 일의 기준을 다시 세웁니다.\n2026년 업무는 더 빠르고 복잡해집니다.\nAI와 AX 흐름을 정확히 이해하세요!",
    "AI Work System은 반복 업무를 줄이는 도구입니다.\n좋은 결과는 사람의 판단에서 시작됩니다.\nHuman Skill을 정확히 증명하세요!",
    "Work Trends는 일의 방식과 생산성을 다룹니다.\n작은 실행이 오늘의 기록을 바꿉니다.\nReady Go를 정확히 입력하세요!",
    "AX Workflow는 업무 과정을 다시 설계합니다.\n2번 확인하는 습관은 실수를 줄입니다.\nFocus on Work를 끝까지 유지하세요!",
    "Marketing Sales Tech는 데이터를 읽는 힘입니다.\n2026년 일잘러는 도구를 이해해야 합니다.\nSpeed Up으로 정확도를 지키세요!",
    "Skill Growth Platform은 성장의 기준입니다.\n1번의 도전이 새로운 기록을 만듭니다.\nKeep Going을 흔들림 없이 입력하세요!",
    "Culture Collaboration은 소통 방식을 바꿉니다.\n좋은 협업은 빠른 확인에서 시작됩니다.\nTeam Work를 정확히 완성하세요!",
    "Office Stationery Tools도 업무 속도를 바꿉니다.\n작은 도구 하나가 반복 시간을 줄입니다.\nCheck Again을 마지막까지 확인하세요!",
    "GOV Tech 2026은 공공 업무 혁신을 보여줍니다.\n기준을 세우면 복잡한 일도 빨라집니다.\nClear Stage를 정확히 완성하세요!",
    "Leaders Day는 팀을 이끄는 사람의 시간입니다.\n리더의 업무는 명확한 판단에서 시작됩니다.\nBeat AI를 향해 끝까지 집중하세요!"
  ]
];

function defaultStageTextRows() {
  let id = 0;
  const createdAt = "2026-01-01T00:00:00+09:00";
  return ["normal", "ai_challenge"].flatMap((gameMode) =>
    defaultStageTextsByStage.flatMap((texts, stageIndex) =>
      texts.map((text) => ({
        id: String((id += 1)),
        game_mode: gameMode,
        stage_number: String(stageIndex + 1),
        text,
        is_active: "true",
        created_at: createdAt,
        updated_at: createdAt
      }))
    )
  );
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src, dest, options = {}) {
  if (!fs.existsSync(src)) return;
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sourcePath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (options.skip?.(sourcePath, entry)) continue;
    if (entry.isDirectory()) copyDir(sourcePath, destPath, options);
    else if (entry.isFile()) fs.copyFileSync(sourcePath, destPath);
  }
}

function labelLine(header) {
  return header.map((key) => headerLabels[key] ?? key).join(",");
}

function writeCsvIfMissing(file, header, rows = []) {
  if (fs.existsSync(file)) return;
  const labeled = labelLine(header);
  if (rows.length > 0 && typeof rows[0] === "object") {
    writeCsvObjects(file, header, rows);
    return;
  }
  const body = [labeled, ...rows].join("\r\n") + "\r\n";
  fs.writeFileSync(file, `\uFEFF${body}`, "utf8");
}

function writeCsvObjects(file, header, rows) {
  const body = stringify(
    rows.map((row) => Object.fromEntries(header.map((key) => [key, row[key] ?? ""]))),
    {
      header: true,
      columns: header.map((key) => ({ key, header: headerLabels[key] ?? key })),
      record_delimiter: "\r\n",
      quoted_match: /[",\r\n]/
    }
  );
  fs.writeFileSync(file, `\uFEFF${body}`, "utf8");
}

function writeEmptyCsv(file, header) {
  ensureDir(path.dirname(file));
  writeCsvObjects(file, header, []);
}

function resetRelease() {
  fs.rmSync(release, { recursive: true, force: true });
  ensureDir(release);
}

function copyUnpackedRuntime() {
  const variants = [
    { dir: "typing", exe: "일잘러 타자왕은 누구.exe", unpackedExe: "일잘러 타자왕은 누구.exe" },
    { dir: "typing-leaderboard", exe: "일잘러 타자왕은 누구_리더보드.exe", unpackedExe: "일잘러 타자왕은 누구 리더보드.exe" },
    { dir: "ai", exe: "AI 타자왕을 이겨라.exe", unpackedExe: "AI 타자왕을 이겨라.exe" },
    { dir: "ai-leaderboard", exe: "AI 타자왕을 이겨라_리더보드.exe", unpackedExe: "AI 타자왕을 이겨라 리더보드.exe" },
    { dir: "practice", exe: "타자왕 연습모드.exe", unpackedExe: "타자왕 연습모드.exe" },
    { dir: "practice-leaderboard", exe: "타자왕 연습모드_리더보드.exe", unpackedExe: "타자왕 연습모드 리더보드.exe" }
  ];
  const baseUnpacked = path.join(root, "release-build", variants[0].dir, "win-unpacked");
  if (!fs.existsSync(baseUnpacked)) throw new Error("Missing typing unpacked build output");
  copyDir(baseUnpacked, release);
  for (const variant of variants) {
    const unpacked = path.join(root, "release-build", variant.dir, "win-unpacked");
    const exe = path.join(unpacked, variant.unpackedExe);
    if (!fs.existsSync(exe)) throw new Error(`Missing ${variant.dir} build output`);
    fs.copyFileSync(exe, path.join(release, variant.exe));
  }
}

function applyExeIcon(exeName, iconName) {
  const rcedit = path.join(root, "node_modules", "electron-winstaller", "vendor", "rcedit.exe");
  const exe = path.join(release, exeName);
  const icon = path.join(root, "assets", "icons", iconName);
  if (!fs.existsSync(rcedit)) throw new Error("Missing rcedit executable for Windows icon resources");
  if (!fs.existsSync(exe)) throw new Error(`Missing release executable: ${exeName}`);
  if (!fs.existsSync(icon)) throw new Error(`Missing icon: ${iconName}`);
  const tempRoot = path.join(process.env.PUBLIC || "C:\\Users\\Public", "Documents", "ESTsoft", "CreatorTemp");
  ensureDir(tempRoot);
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "typingking-rcedit-"));
  try {
    const tempExe = path.join(tempDir, "app.exe");
    const tempIcon = path.join(tempDir, "app.ico");
    fs.copyFileSync(exe, tempExe);
    fs.copyFileSync(icon, tempIcon);
    execFileSync(rcedit, [tempExe, "--set-icon", tempIcon], { stdio: "inherit" });
    fs.copyFileSync(tempExe, exe);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function ensureProjectData() {
  ensureDir(path.join(root, "data", "backups"));
  ensureDir(path.join(root, "data", "recovery"));
  ensureDir(path.join(root, "data", "local_queue"));
  ensureDir(path.join(root, "data", "local_queue_practice"));
  ensureDir(path.join(root, "data", "processed"));
  writeCsvIfMissing(path.join(root, "data", "records.csv"), headers.records);
  writeCsvIfMissing(path.join(root, "data", "admin_audit.csv"), headers.audit);
  writeCsvIfMissing(path.join(root, "data", "stage_texts.csv"), headers.stages, defaultStageTextRows());
}

function prepareReleaseData() {
  const releaseData = path.join(release, "data");
  ensureDir(releaseData);
  writeEmptyCsv(path.join(releaseData, "records.csv"), headers.records);
  writeEmptyCsv(path.join(releaseData, "admin_audit.csv"), headers.audit);
  fs.copyFileSync(path.join(root, "data", "stage_texts.csv"), path.join(releaseData, "stage_texts.csv"));
  for (const dir of ["backups", "recovery", "local_queue", "local_queue_practice", "processed"]) {
    ensureDir(path.join(releaseData, dir));
  }
}

ensureProjectData();
resetRelease();
copyUnpackedRuntime();
applyExeIcon("일잘러 타자왕은 누구.exe", "typing_app_icon.ico");
applyExeIcon("AI 타자왕을 이겨라.exe", "typing_app_icon.ico");
applyExeIcon("일잘러 타자왕은 누구_리더보드.exe", "leaderboard_app_icon.ico");
applyExeIcon("AI 타자왕을 이겨라_리더보드.exe", "leaderboard_app_icon.ico");
applyExeIcon("타자왕 연습모드.exe", "typing_app_icon.ico");
applyExeIcon("타자왕 연습모드_리더보드.exe", "leaderboard_app_icon.ico");
prepareReleaseData();
copyDir(path.join(root, "config"), path.join(release, "config"));
copyDir(path.join(root, "assets"), path.join(release, "assets"), {
  skip: (sourcePath, entry) => entry.isDirectory() && entry.name === "_source"
});
ensureDir(path.join(release, "exports"));
fs.copyFileSync(path.join(root, "README.md"), path.join(release, "README.md"));
console.log("release ready");
