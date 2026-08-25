import type { StageText } from "../types";

export type StageTextRotationState = Record<string, string[]>;

export const STAGE_TEXT_ROTATION_STORAGE_KEY = "typingKing.stageTextRotation.v1";

function rotationKey(mode: string, stage: number): string {
  return `${mode}:${stage}`;
}

function rowKey(row: StageText): string {
  return (row.id || row.text).trim();
}

export function parseStageTextRotationState(value: string | null): StageTextRotationState {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const state: StageTextRotationState = {};
    Object.entries(parsed as Record<string, unknown>).forEach(([key, list]) => {
      if (!Array.isArray(list)) return;
      state[key] = list.filter((item): item is string => typeof item === "string");
    });
    return state;
  } catch {
    return {};
  }
}

export function pickRotatingStageText(
  activeRows: StageText[],
  mode: string,
  stage: number,
  state: StageTextRotationState,
  random: () => number = Math.random
): { row: StageText; nextState: StageTextRotationState } {
  if (activeRows.length === 0) throw new Error("No active stage text rows");
  const key = rotationKey(mode, stage);
  const activeKeys = new Set(activeRows.map(rowKey));
  const recent = (state[key] ?? []).filter((item) => activeKeys.has(item));
  const recentSet = new Set(recent);
  const freshRows = activeRows.filter((row) => !recentSet.has(rowKey(row)));
  const pool = freshRows.length > 0 ? freshRows : activeRows;
  const selected = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  const selectedKey = rowKey(selected);
  const memorySize = Math.max(0, activeRows.length - 1);
  const recentBase = freshRows.length > 0 ? recent : [];
  const nextRecent =
    memorySize === 0
      ? []
      : [...recentBase.filter((item) => item !== selectedKey), selectedKey].slice(-memorySize);

  return {
    row: selected,
    nextState: {
      ...state,
      [key]: nextRecent
    }
  };
}
