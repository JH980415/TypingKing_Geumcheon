import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const defaultTargets = ["release", "release-geumcheon"];
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

function scanText(text, label, findings) {
  for (const needle of exactNeedles) {
    if (text.includes(needle)) findings.push({ file: label, category: "exact secret needle" });
  }

  for (const match of text.matchAll(phonePattern)) {
    const value = match[0];
    const compact = value.replace(/\D/g, "");
    if (allowedPhones.has(value) || allowedPhones.has(compact)) continue;
    if (/^0100{7,8}$/.test(compact)) continue;
    findings.push({ file: label, category: "phone pattern" });
  }
}

async function scanTextFile(filePath, label, findings) {
  if (!shouldScanFile(filePath)) return;
  let text = "";
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }

  scanText(text, label, findings);
}

async function scanExecutable(filePath, label, findings) {
  const binaryNeedles = exactNeedles.flatMap((value) => [
    { value, bytes: Buffer.from(value, "utf8"), encoding: "utf-8" },
    { value, bytes: Buffer.from(value, "utf16le"), encoding: "utf-16le" }
  ]);
  if (binaryNeedles.length === 0) return;
  const overlapBytes = Math.max(
    64,
    ...binaryNeedles.map(({ bytes }) => bytes.length + 4)
  );
  let carry = Buffer.alloc(0);
  const seen = new Set();
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    for (const { value, bytes, encoding } of binaryNeedles) {
      if (combined.indexOf(bytes) >= 0 && !seen.has(value)) {
        seen.add(value);
        findings.push({ file: label, category: "exact secret needle", encoding });
      }
    }
    carry = combined.subarray(Math.max(0, combined.length - overlapBytes));
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
    const fileLabel = path.relative(target, file) ? `${label}/${path.relative(target, file)}` : label;
    if (path.extname(file).toLowerCase() === ".exe") await scanExecutable(file, fileLabel, findings);
    else await scanTextFile(file, fileLabel, findings);
  }
}

function parseTargets(args) {
  if (args.length === 0) {
    return { targets: defaultTargets.map((target) => path.join(root, target)), usesDefaultTargets: true };
  }
  const targets = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--target") throw new Error(`Unknown argument: ${args[index]}`);
    const target = args[index + 1];
    if (!target || target.startsWith("--")) throw new Error("--target requires a directory or file path");
    targets.push(path.resolve(root, target));
    index += 1;
  }
  return { targets, usesDefaultTargets: false };
}

function targetLabel(target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") ? relative.replaceAll(path.sep, "/") : target;
}

function safeFindingPath(file) {
  const relative = path.isAbsolute(file) ? path.basename(file) : file.replaceAll(path.sep, "/");
  if (exactNeedles.some((needle) => relative.includes(needle))) return "[redacted-file]";
  if (/010[-\s]?\d{3,4}[-\s]?\d{4}/.test(relative)) return "[redacted-file]";
  return relative;
}

async function main() {
  const findings = [];
  const { targets, usesDefaultTargets } = parseTargets(process.argv.slice(2));
  await Promise.all(targets.map((target) => scanTarget(target, targetLabel(target), findings)));

  if (usesDefaultTargets) {
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
  }

  if (findings.length > 0) {
    console.error(`개인정보 의심 문자열이 ${findings.length}건 발견되었습니다.`);
    for (const finding of findings) {
      const encoding = finding.encoding ? ` (${finding.encoding})` : "";
      console.error(`- ${safeFindingPath(finding.file)}: ${finding.category}${encoding}`);
    }
    process.exit(1);
  }

  console.log(`PII 검사 통과: ${targets.map(targetLabel).join(", ")} 대상에서 개인정보 의심 문자열을 찾지 못했습니다.${usesDefaultTargets ? " release ZIP도 검사했습니다." : ""}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
