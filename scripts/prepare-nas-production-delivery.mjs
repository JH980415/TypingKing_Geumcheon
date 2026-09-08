import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE_FILES = [
  "leaderboard_01.device-profile.json",
  "player_01.device-profile.json",
  "player_02.device-profile.json",
  "player_03.device-profile.json",
  "player_04.device-profile.json",
];
const DELIVERY_SENTINEL = ".typingking-nas-delivery-root";
const DELIVERY_SENTINEL_CONTENT = "TypingKing R6 NAS generated delivery v1\n";

export function prepareNasProductionDelivery({ projectRoot, outputRoot }) {
  const root = path.resolve(projectRoot);
  const output = path.resolve(outputRoot);
  const source = path.join(root, "deployment", "nas-production");
  const designatedRoot = path.join(root, "Codex", "Artifacts", "R6_v2");
  const designatedOutput = path.join(designatedRoot, "nas-production-delivery");
  if (output !== designatedOutput) throw new Error("OUTPUT_PATH_UNSAFE");
  assertNoLinkedPath(root, output);
  if (fs.existsSync(output)) {
    const outputStat = fs.lstatSync(output);
    if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error("OUTPUT_PATH_UNSAFE");
    const entries = fs.readdirSync(output);
    if (entries.length > 0) {
      const sentinel = path.join(output, DELIVERY_SENTINEL);
      if (!fs.existsSync(sentinel) || fs.lstatSync(sentinel).isSymbolicLink()
        || fs.readFileSync(sentinel, "utf8") !== DELIVERY_SENTINEL_CONTENT) {
        throw new Error("OUTPUT_NOT_OWNED");
      }
      fs.rmSync(output, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(output, { recursive: true });
  fs.cpSync(source, output, { recursive: true });
  fs.writeFileSync(path.join(output, DELIVERY_SENTINEL), DELIVERY_SENTINEL_CONTENT, { encoding: "utf8", flag: "wx" });

  const serverOutput = path.join(output, "server");
  const serviceOutput = path.join(serverOutput, "services", "nas-record-api");
  fs.mkdirSync(serviceOutput, { recursive: true });
  fs.cpSync(path.join(root, "services", "nas-record-api", "src"), path.join(serviceOutput, "src"), { recursive: true });
  const builtServer = path.join(root, "services", "nas-record-api", "dist", "server.cjs");
  if (!fs.existsSync(builtServer) || !fs.statSync(builtServer).isFile()) throw new Error("SERVER_BUILD_MISSING");
  fs.mkdirSync(path.join(serviceOutput, "dist"), { recursive: true });
  fs.copyFileSync(builtServer, path.join(serviceOutput, "dist", "server.cjs"));
  fs.cpSync(path.join(root, "shared"), path.join(serverOutput, "shared"), { recursive: true });
  for (const name of ["package.json", "package-lock.json", "tsconfig.json"]) {
    fs.copyFileSync(path.join(root, "services", "nas-record-api", name), path.join(serviceOutput, name));
  }
  const manifest = walkFiles(output)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((file) => {
      const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      return `${hash}  ${path.relative(output, file).split(path.sep).join("/")}`;
    })
    .join("\n");
  fs.writeFileSync(path.join(output, "MANIFEST_SHA256.txt"), `${manifest}\n`, "utf8");
  return { outputRoot: output, profileFiles: [...PROFILE_FILES] };
}

function assertNoLinkedPath(root, output) {
  const relative = path.relative(root, output);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("OUTPUT_PATH_UNSAFE");
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("OUTPUT_PATH_UNSAFE");
  }
}

function walkFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(target) : [target];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outputRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(projectRoot, "Codex", "Artifacts", "R6_v2", "nas-production-delivery");
  const result = prepareNasProductionDelivery({ projectRoot, outputRoot });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
