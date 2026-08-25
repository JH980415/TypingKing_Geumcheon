import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();

const recordHeader =
  "기록ID,생성일시,완료일시,참여자명,휴대폰앞자리,휴대폰가운데자리,휴대폰끝자리,휴대폰번호,휴대폰번호마스킹,출생연도,출생월,출생일,생년월일,생년월일마스킹,개인정보동의,개인정보동의일시,1단계문구,2단계문구,3단계문구,1단계글자수,2단계글자수,3단계글자수,전체글자수,1단계시간ms,2단계시간ms,3단계시간ms,1단계누적ms,2단계누적ms,전체시간ms,1단계표시초,2단계표시초,3단계표시초,전체표시초,최종타수,최종정확도,앱버전,테스트기록,디버그기록,디버그모드유형,메모,게임모드,AI사용여부,AI챌린지상태,AI패배스테이지,AI1단계타수,AI2단계타수,AI3단계타수,AI1단계시간ms,AI2단계시간ms,AI3단계시간ms,AI전체시간ms,1단계AI대결결과,2단계AI대결결과,3단계AI대결결과,최종AI대결결과,1단계시간차ms,2단계시간차ms,3단계시간차ms,최종시간차ms,참여자표시기록ms,AI표시기록ms,참여자평균타수,AI평균타수,AI타자왕결과,참여자점수진행률,AI점수진행률,대결시간ms,종료스테이지,원본기록ID,관리자수정여부";
const auditHeader = "감사ID,작업유형,대상기록ID,변경전값,변경후값,관리자명,작업일시";

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function removePath(target) {
  if (!(await exists(target))) return false;
  await fs.rm(target, { recursive: true, force: true });
  return true;
}

async function emptyDirectory(target) {
  if (!(await exists(target))) return 0;
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) return 0;
  const entries = await fs.readdir(target);
  await Promise.all(entries.map((entry) => fs.rm(path.join(target, entry), { recursive: true, force: true })));
  return entries.length;
}

async function writeHeaderOnly(target, header) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${header}\n`, "utf8");
}

async function main() {
  let removed = 0;
  const rootEntries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of rootEntries) {
    const name = entry.name;
    if (/^tmp-/i.test(name) || /^backup_before_build_/i.test(name) || /^release.*\.zip$/i.test(name)) {
      if (await removePath(path.join(root, name))) removed += 1;
    }
  }

  if (await removePath(path.join(root, "tmp-ai-test"))) removed += 1;

  const cleanedFileCount = await Promise.all(
    [
      path.join("release", "data", "local_queue"),
      path.join("release", "data", "local_queue_practice"),
      path.join("release", "data", "recovery"),
      path.join("release", "data", "processed"),
      path.join("release", "exports"),
      path.join("release", "logs")
    ].map((relative) => emptyDirectory(path.join(root, relative)))
  );

  await writeHeaderOnly(path.join(root, "release", "data", "records.csv"), recordHeader);
  await writeHeaderOnly(path.join(root, "release", "data", "admin_audit.csv"), auditHeader);

  const cleaned = cleanedFileCount.reduce((sum, value) => sum + value, 0);
  console.log(`정리 완료: 임시 항목 ${removed}개, 테스트 파일 ${cleaned}개를 정리했습니다.`);
  console.log("release의 records.csv와 admin_audit.csv는 헤더만 남겼습니다. 작업폴더 데이터는 변경하지 않았습니다.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
