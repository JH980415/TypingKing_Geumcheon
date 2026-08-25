import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const releaseDir = path.join(root, "release");
const binaryExtensions = new Set([
  ".exe",
  ".dll",
  ".ico",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bin",
  ".pak",
  ".dat",
  ".node"
]);

const exactNeedles = String(process.env.TYPINGKING_PII_NEEDLES ?? "")
  .split("|")
  .map((value) => value.trim())
  .filter(Boolean);
const phonePattern = /010[-\s]?\d{3,4}[-\s]?\d{4}/g;
const allowedPhones = new Set(["010-0000-0000", "01000000000"]);

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(target) {
  if (!(await exists(target))) return [];
  const stat = await fs.stat(target);
  if (stat.isFile()) return [target];
  const entries = await fs.readdir(target, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => listFiles(path.join(target, entry.name))));
  return nested.flat();
}

function shouldScanFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (binaryExtensions.has(extension)) return false;
  return true;
}

async function scanTextFile(filePath, label, findings) {
  if (!shouldScanFile(filePath)) return;
  let text = "";
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }

  for (const needle of exactNeedles) {
    if (text.includes(needle)) findings.push({ file: label, value: needle });
  }

  for (const match of text.matchAll(phonePattern)) {
    const value = match[0];
    const compact = value.replace(/\D/g, "");
    if (allowedPhones.has(value) || allowedPhones.has(compact)) continue;
    if (/^0100{7,8}$/.test(compact)) continue;
    findings.push({ file: label, value });
  }
}

async function extractZip(zipPath) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "typingking-pii-"));
  const command = [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tempDir.replace(/'/g, "''")}' -Force`
  ];
  const result = spawnSync("powershell", command, { encoding: "utf8" });
  if (result.status !== 0) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw new Error(`ZIP 검사 압축 해제 실패: ${zipPath}`);
  }
  return tempDir;
}

async function scanTarget(target, label, findings) {
  const files = await listFiles(target);
  for (const file of files) {
    await scanTextFile(file, path.relative(target, file) ? `${label}/${path.relative(target, file)}` : label, findings);
  }
}

async function main() {
  const findings = [];
  await scanTarget(releaseDir, "release", findings);

  const rootEntries = await fs.readdir(root);
  const zipFiles = rootEntries.filter((name) => /^release.*\.zip$/i.test(name));
  for (const zipFile of zipFiles) {
    const zipPath = path.join(root, zipFile);
    const tempDir = await extractZip(zipPath);
    try {
      await scanTarget(tempDir, zipFile, findings);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  if (findings.length > 0) {
    console.error("개인정보 의심 문자열이 발견되었습니다.");
    for (const finding of findings) {
      console.error(`- ${finding.file}: ${finding.value}`);
    }
    process.exit(1);
  }

  console.log("PII 검사 통과: release 폴더와 release ZIP에서 개인정보 의심 문자열을 찾지 못했습니다.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
