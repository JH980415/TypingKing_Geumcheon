import type { StageText } from "../types";

export type StageTextShuffleBag = {
  remainingIds: string[];
  lastSelectedId?: string;
};

export type StageTextShuffleState = {
  schemaVersion: 2;
  bags: Record<string, StageTextShuffleBag>;
};

export type StageTextBagKeyInput = {
  eventId: string;
  catalogVersion: string;
  sessionKind: "official" | "practice";
  gameMode: "ai_challenge";
  stageNumber: 1 | 2 | 3;
};

export function stageTextBagKey(input: StageTextBagKeyInput): string {
  return [input.eventId, input.catalogVersion, input.sessionKind, input.gameMode, input.stageNumber].join(":");
}

function shuffledIds(rows: readonly StageText[], random: () => number): string[] {
  const ids = rows.map((row) => row.id);
  for (let index = ids.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.min(index, Math.max(0, Math.floor(random() * (index + 1))));
    [ids[index], ids[swapIndex]] = [ids[swapIndex], ids[index]];
  }
  return ids;
}

export function drawStageTextFromBag(
  rows: readonly StageText[],
  key: string,
  state: StageTextShuffleState,
  random: () => number = Math.random
): { selected: StageText; nextState: StageTextShuffleState } {
  const activeRows = rows.filter((row) => row.is_active === "true");
  if (activeRows.length === 0) throw new Error("No active stage text rows");
  const rowById = new Map(activeRows.map((row) => [row.id, row]));
  const previous = state.bags[key];
  let remainingIds = (previous?.remainingIds ?? []).filter((id) => rowById.has(id));
  const lastSelectedId = previous?.lastSelectedId;

  if (remainingIds.length === 0) {
    remainingIds = shuffledIds(activeRows, random);
    if (remainingIds.length > 1 && remainingIds[0] === lastSelectedId) {
      [remainingIds[0], remainingIds[1]] = [remainingIds[1], remainingIds[0]];
    }
  }

  const selectedId = remainingIds[0];
  const selected = rowById.get(selectedId);
  if (!selected) throw new Error("Stage text shuffle bag is invalid");
  return {
    selected,
    nextState: {
      schemaVersion: 2,
      bags: {
        ...state.bags,
        [key]: { remainingIds: remainingIds.slice(1), lastSelectedId: selected.id }
      }
    }
  };
}
