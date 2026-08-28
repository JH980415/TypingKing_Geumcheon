/**
 * generate-title-derivatives.mjs
 * ------------------------------------------------------------------
 * 한줄형 타이틀 PNG(누끼)에서 위치별 파생본을 생성한다.
 * - 의존성 없음(Node 내장 fs/zlib만 사용). package.json 변경 불필요.
 * - 앱 소스코드는 건드리지 않는다. (이미지 읽기/생성 전용)
 * - 원본은 절대 덮어쓰지 않는다(출력 파일명이 모두 다름).
 *
 * 입력(기본): assets/_source/ 에 아래 2개 원본을 둔다.
 *   - 일잘러_타자왕은_누구_누끼.png   (일반)
 *   - AI_타자왕을_이겨라_누끼.png      (AI)
 *   (환경변수 SRC_DIR / SRC_NORMAL / SRC_AI 로 경로 지정 가능)
 *
 * 출력(기본):
 *   assets/normal_typing/normal_title_oneline_trimmed.png   (상하 타이트 크롭, 대형/게임/리더보드/결과 공용)
 *   assets/normal_typing/normal_title_compact.png           (대형 모드명만 — 카드용)
 *   assets/ai_challenge/ai_title_oneline_trimmed.png
 *   assets/ai_challenge/ai_title_compact.png
 *   (환경변수 OUT_NORMAL / OUT_AI 로 출력 폴더 지정 가능)
 *
 * 실행:  node scripts/generate-title-derivatives.mjs
 * ------------------------------------------------------------------
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// ---------- 설정 (안전 여백 등) ----------
const ALPHA_THRESHOLD = 16;       // 이 값 초과를 "내용 픽셀"로 본다
const ONELINE_MARGIN = 24;        // 한줄 크롭 상하 안전 여백(px)
const COMPACT_MARGIN_Y = 18;      // compact 상하 여백
const COMPACT_MARGIN_X = 18;      // compact 좌우 여백
const ROW_GAP_TOLERANCE = 12;     // 밴드 병합 시 허용 공백 행 수
const COL_GAP_TOLERANCE = 40;     // compact 가로 밴드 병합 허용 공백 열 수

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// ---------- PNG decode (8-bit, colorType 2/6) -> RGBA ----------
function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
function decodePNG(file) {
  const buf = fs.readFileSync(file);
  if (!(buf[0] === 0x89 && buf[1] === 0x50)) throw new Error(`PNG 아님: ${file}`);
  let off = 8, W = 0, H = 0, bd = 0, ct = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString("ascii", off + 4, off + 8); const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { W = data.readUInt32BE(0); H = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bd !== 8 || (ct !== 6 && ct !== 2)) throw new Error(`지원하지 않는 PNG(bitDepth=${bd}, colorType=${ct}). 8-bit RGB/RGBA만 처리`);
  const ch = ct === 6 ? 4 : 3; const stride = W * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(H * stride); let rp = 0;
  for (let y = 0; y < H; y++) {
    const ft = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const v = raw[rp++]; const left = x >= ch ? px[y * stride + x - ch] : 0; const up = y > 0 ? px[(y - 1) * stride + x] : 0; const ul = (x >= ch && y > 0) ? px[(y - 1) * stride + x - ch] : 0;
      let val; switch (ft) { case 0: val = v; break; case 1: val = v + left; break; case 2: val = v + up; break; case 3: val = v + ((left + up) >> 1); break; case 4: val = v + paeth(left, up, ul); break; default: val = v; }
      px[y * stride + x] = val & 0xff;
    }
  }
  // RGBA로 정규화
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0, j = 0; i < W * H; i++) {
    rgba[j++] = px[i * ch]; rgba[j++] = px[i * ch + 1]; rgba[j++] = px[i * ch + 2]; rgba[j++] = ct === 6 ? px[i * ch + 3] : 255;
  }
  return { W, H, rgba };
}

// ---------- PNG encode (RGBA 8-bit) ----------
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii"); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(W, H, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = W * 4; const raw = Buffer.alloc(H * (stride + 1));
  for (let y = 0; y < H; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- 분석 유틸 ----------
function alphaAt(img, x, y) { return img.rgba[(y * img.W + x) * 4 + 3]; }
function contentBBox(img) {
  let minX = img.W, minY = img.H, maxX = -1, maxY = -1;
  for (let y = 0; y < img.H; y++) for (let x = 0; x < img.W; x++) if (alphaAt(img, x, y) > ALPHA_THRESHOLD) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  return { minX, minY, maxX, maxY };
}
function rowInk(img) { const r = new Array(img.H).fill(0); for (let y = 0; y < img.H; y++) { let c = 0; for (let x = 0; x < img.W; x++) if (alphaAt(img, x, y) > ALPHA_THRESHOLD) c++; r[y] = c; } return r; }
// 대형 타이틀 밴드: 잉크 최대행(peak) 주변에서 ink >= peak*RATIO 인 연속 구간을 잡는다.
// 작은 eyebrow("2026 일잘러 페스타")와 얇은 네온 줄은 잉크가 낮아 자연히 제외된다.
// 높을수록 eyebrow("2026 일잘러 페스타")를 더 공격적으로 제외(=본문만 크게). 시각 확인 후 환경변수로 조정.
// 0.12=안전(거의 oneline과 동일) / 0.30=권장(eyebrow 대부분 제외) / 0.45+=본문만 더 타이트(글자 잘림 위험↑)
const TITLE_BAND_RATIO = Number(process.env.TITLE_BAND_RATIO) || 0.30;
function titleBand(img) {
  const r = rowInk(img); let peak = 0, pIdx = 0;
  for (let y = 0; y < img.H; y++) if (r[y] > peak) { peak = r[y]; pIdx = y; }
  if (peak <= 0) return null;
  const cut = peak * TITLE_BAND_RATIO;
  let a = pIdx, b = pIdx;
  while (a - 1 >= 0 && r[a - 1] >= cut) a--;
  while (b + 1 < img.H && r[b + 1] >= cut) b++;
  return [a, b];
}
// 주어진 y밴드 안에서 가로 내용 범위(열)
function colRangeInBand(img, y0, y1) {
  let minX = img.W, maxX = -1;
  for (let y = y0; y <= y1; y++) for (let x = 0; x < img.W; x++) if (alphaAt(img, x, y) > ALPHA_THRESHOLD) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
  return { minX, maxX };
}
function crop(img, x0, y0, x1, y1) {
  const W = x1 - x0 + 1, H = y1 - y0 + 1; const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) img.rgba.copy(out, y * W * 4, ((y0 + y) * img.W + x0) * 4, ((y0 + y) * img.W + x0) * 4 + W * 4);
  return { W, H, rgba: out };
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- 한 모드 처리 ----------
function processOne(label, srcFile, outDir, baseName) {
  const img = decodePNG(srcFile);
  const bb = contentBBox(img);
  const report = { label, src: srcFile, srcSize: `${img.W}x${img.H}`, contentBBox: bb };

  // 1) oneline_trimmed : 폭 전체 유지, 상하만 안전여백 두고 크롭
  const tY0 = clamp(bb.minY - ONELINE_MARGIN, 0, img.H - 1);
  const tY1 = clamp(bb.maxY + ONELINE_MARGIN, 0, img.H - 1);
  const trimmed = crop(img, 0, tY0, img.W - 1, tY1);
  const trimmedPath = path.join(outDir, `${baseName}_oneline_trimmed.png`);
  fs.writeFileSync(trimmedPath, encodePNG(trimmed.W, trimmed.H, trimmed.rgba));
  report.oneline = { crop: `x[0..${img.W - 1}] y[${tY0}..${tY1}]`, size: `${trimmed.W}x${trimmed.H}`, aspect: +(trimmed.W / trimmed.H).toFixed(2), file: trimmedPath };

  // 2) compact : 대형 타이틀 밴드만 (eyebrow 제외) — 폭 전체 유지, 상하만 타이트.
  //    작은 카드에서 같은 픽셀 높이에 글자가 더 크게 보이도록 한다.
  const band = titleBand(img);
  let compactInfo = "밴드 검출 실패 → trimmed 재사용";
  if (band) {
    const [bY0, bY1] = band;
    const cy0 = clamp(bY0 - COMPACT_MARGIN_Y, 0, img.H - 1);
    const cy1 = clamp(bY1 + COMPACT_MARGIN_Y, 0, img.H - 1);
    const compact = crop(img, 0, cy0, img.W - 1, cy1);
    const compactPath = path.join(outDir, `${baseName}_compact.png`);
    fs.writeFileSync(compactPath, encodePNG(compact.W, compact.H, compact.rgba));
    // 검증: 상/하 가장자리에 내용이 닿지 않는지(=세로로 글자 안 잘림). 좌우는 원본도 풀블리드라 무시.
    const cb = contentBBox(compact);
    compactInfo = {
      titleBand: `y[${bY0}..${bY1}]`, crop: `x[0..${img.W - 1}] y[${cy0}..${cy1}]`,
      size: `${compact.W}x${compact.H}`, aspect: +(compact.W / compact.H).toFixed(2),
      heightVsOneline: `${Math.round((cy1 - cy0 + 1) / (tY1 - tY0 + 1) * 100)}% of oneline`,
      vEdgeSafe: (cb.minY > 0 && cb.maxY < compact.H - 1), file: compactPath
    };
  }
  report.compact = compactInfo;
  return report;
}

// ---------- main ----------
function findSrc(dir, kind) {
  if (kind === "ai" && process.env.SRC_AI) return process.env.SRC_AI;
  if (kind === "normal" && process.env.SRC_NORMAL) return process.env.SRC_NORMAL;
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".png")) : [];
  const pick = kind === "ai"
    ? names.find((n) => /ai|이겨라/i.test(n))
    : names.find((n) => /누구|일잘러/i.test(n) && !/이겨라|ai/i.test(n));
  if (!pick) throw new Error(`${kind} 원본 PNG를 ${dir} 에서 찾지 못했습니다. SRC_${kind.toUpperCase()} 환경변수로 직접 지정하세요.`);
  return path.join(dir, pick);
}

const root = process.cwd();
const SRC_DIR = process.env.SRC_DIR || path.join(root, "assets", "_source");
const OUT_NORMAL = process.env.OUT_NORMAL || path.join(root, "assets", "normal_typing");
const OUT_AI = process.env.OUT_AI || path.join(root, "assets", "ai_challenge");
fs.mkdirSync(OUT_NORMAL, { recursive: true });
fs.mkdirSync(OUT_AI, { recursive: true });

const reports = [];
reports.push(processOne("일반(normal)", findSrc(SRC_DIR, "normal"), OUT_NORMAL, "normal_title"));
reports.push(processOne("AI", findSrc(SRC_DIR, "ai"), OUT_AI, "ai_title"));

console.log("===== 타이틀 파생본 생성 결과 =====");
for (const r of reports) console.log(JSON.stringify(r, null, 2));
const touch = reports.some((r) => r.compact && r.compact.vEdgeSafe === false);
console.log("\n[OK] 파생본 생성 완료.");
console.log("  - oneline_trimmed : 상하 여백만 제거(안전, 모든 큰 슬롯 공용).");
console.log("  - compact         : eyebrow 제외 본문 위주(카드용). 현재 TITLE_BAND_RATIO=" + TITLE_BAND_RATIO + ".");
if (touch) console.log("  ※ compact 상/하 가장자리에 픽셀이 닿음(대개 네온 글로우). 카드 PNG를 열어 '글자'가 잘리지 않았는지 육안 확인하고,");
if (touch) console.log("    잘렸으면 TITLE_BAND_RATIO 를 낮춰(예: 0.18) 재실행, eyebrow가 남아 거슬리면 높여(예: 0.45) 재실행하세요.");
