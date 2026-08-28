export function normalizeForCompare(value: string): string {
  return value.normalize("NFC");
}

export function stripDisplayLineBreaks(value: string): string {
  return normalizeForCompare(value).replace(/\r\n/g, "\n").replace(/\n/g, "");
}

export function splitChars(value: string): string[] {
  return Array.from(normalizeForCompare(value));
}

export function splitTypeableChars(value: string): string[] {
  return Array.from(stripDisplayLineBreaks(value));
}

export function countTypeableChars(value: string): number {
  return splitTypeableChars(value).length;
}

function getCharKeystrokeUnits(char: string): number {
  const code = char.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const syllableIndex = code - 0xac00;
    const hasFinalConsonant = syllableIndex % 28 !== 0;
    return hasFinalConsonant ? 3 : 2;
  }
  if (char === "\n" || char === "\r") return 0;
  return 1;
}

export function countConvertedTypingUnits(value: string): number {
  return splitChars(value).reduce((sum, char) => sum + getCharKeystrokeUnits(char), 0);
}

export function countMatchingPrefixTypingUnits(input: string, target: string): number {
  const inputChars = splitTypeableChars(input);
  const targetChars = splitTypeableChars(target);
  let matched = "";
  for (let index = 0; index < targetChars.length; index += 1) {
    if (inputChars[index] !== targetChars[index]) break;
    matched += targetChars[index];
  }
  return countConvertedTypingUnits(matched);
}

export function getTextPrefixByTypingUnits(target: string, units: number): string {
  const targetChars = splitTypeableChars(target);
  const pieces: string[] = [];
  let used = 0;
  for (const char of targetChars) {
    const nextUnits = getCharKeystrokeUnits(char);
    if (used + nextUnits > units) break;
    pieces.push(char);
    used += nextUnits;
  }
  return pieces.join("");
}

export function splitTargetLines(target: string): string[] {
  return normalizeForCompare(target)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => splitTypeableChars(line).join(""));
}

export type LineProgress = {
  lines: string[];
  completedLineCount: number;
  currentLineIndex: number;
  currentLineInput: string;
  allowedLength: number;
  isCurrentLineComplete: boolean;
  isComplete: boolean;
};

export function getLineProgress(input: string, target: string): LineProgress {
  const inputChars = splitTypeableChars(input);
  const lines = splitTargetLines(target);
  let cursor = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineTarget = lines[lineIndex] ?? "";
    const lineLength = lineTarget.length;
    const lineInput = inputChars.slice(cursor, cursor + lineLength).join("");
    const isLineComplete = lineInput.length === lineLength && lineInput === lineTarget;

    if (!isLineComplete) {
      return {
        lines,
        completedLineCount: lineIndex,
        currentLineIndex: lineIndex,
        currentLineInput: lineInput,
        allowedLength: cursor + lineLength,
        isCurrentLineComplete: false,
        isComplete: false
      };
    }

    cursor += lineLength;
  }

  return {
    lines,
    completedLineCount: lines.length,
    currentLineIndex: Math.max(0, lines.length - 1),
    currentLineInput: "",
    allowedLength: cursor,
    isCurrentLineComplete: true,
    isComplete: inputChars.length === cursor
  };
}

export function applyTargetLineBreaks(input: string, target: string): string {
  const inputChars = splitTypeableChars(input);
  const lines = splitTargetLines(target);
  const pieces: string[] = [];
  let cursor = 0;

  lines.forEach((line, lineIndex) => {
    const lineLength = line.length;
    const lineInput = inputChars.slice(cursor, cursor + lineLength).join("");
    pieces.push(lineInput);
    cursor += lineLength;
    if (lineIndex < lines.length - 1 && lineInput.length === lineLength && lineInput === line) {
      pieces.push("\n");
    }
  });

  return pieces.join("");
}

export function getLineInputLimit(input: string, target: string): number {
  return getLineProgress(input, target).allowedLength;
}

export function isLineProgressAllowed(input: string, target: string): boolean {
  const progress = getLineProgress(input, target);
  return countTypeableChars(input) <= progress.allowedLength;
}

export function isExactMatch(input: string, target: string): boolean {
  const inputChars = splitTypeableChars(input);
  const targetChars = splitTargetLines(target).flatMap((line) => Array.from(line));
  return inputChars.length === targetChars.length && targetChars.every((char, index) => inputChars[index] === char);
}

export function calculateAccuracy(input: string, target: string): number {
  const inputChars = splitTypeableChars(input);
  const targetChars = splitTypeableChars(target);
  if (targetChars.length === 0) return 0;
  if (isExactMatch(input, target)) return 100;
  let matches = 0;
  for (let index = 0; index < targetChars.length; index += 1) {
    if (inputChars[index] === targetChars[index]) matches += 1;
  }
  return Math.trunc(((matches / targetChars.length) * 100) * 10) / 10;
}

export function calculateCurrentCpm(input: string, elapsedMs: number, target?: string): number {
  if (elapsedMs < 500) return 0;
  const minutes = elapsedMs / 60000;
  const units = target == null
    ? countConvertedTypingUnits(input)
    : countMatchingPrefixTypingUnits(input, target);
  return Math.max(0, Math.round(units / minutes));
}

export function calculateFinalCpm(totalTypingUnits: number, totalTimeMs: number): number {
  if (totalTimeMs <= 0) return 0;
  return Math.max(0, Math.round(totalTypingUnits / (totalTimeMs / 60000)));
}

export function calculateTotalUserTimeMs(stageTimesMs: readonly number[]): number {
  let total = 0;
  for (const value of stageTimesMs) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid user time");
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error("Invalid user time");
  }
  return total;
}

export function finalizeUserStageTimeMs(startedAtMs: number, endedAtMs: number): number {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) {
    throw new Error("Invalid user time");
  }
  const elapsedMs = Math.round(endedAtMs - startedAtMs);
  if (!Number.isSafeInteger(elapsedMs)) throw new Error("Invalid user time");
  return elapsedMs;
}

export function resumeStageTimerAfterControl(
  stageStartedAtMs: number,
  controlOpenedAtMs: number,
  controlClosedAtMs: number,
  includeControlDwell: boolean
): number {
  if (![stageStartedAtMs, controlOpenedAtMs, controlClosedAtMs].every(Number.isFinite) || controlClosedAtMs < controlOpenedAtMs) {
    throw new Error("Invalid user time");
  }
  void includeControlDwell;
  return stageStartedAtMs + (controlClosedAtMs - controlOpenedAtMs);
}
