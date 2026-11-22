import { describe, expect, it } from 'vitest';
import {
  SAVED_SHOWS_FOR_MS,
  SAVING_SHOWS_AFTER_MS,
  saveChipView,
  type SaveChipLabels,
} from '../src/renderer/SaveChip.js';

const labels: SaveChipLabels = {
  saved: '已儲存',
  dirty: '未儲存',
  saving: '儲存中',
  error: '失敗',
  conflict: '衝突',
  readonly: '唯讀',
};
const idle = { justSaved: false, savingLong: false };

describe('save chip view (QC-071)', () => {
  it('shows nothing while saved, until a save has just finished', () => {
    expect(saveChipView('saved', labels, idle)).toBeNull();
    expect(saveChipView('saved', labels, { ...idle, justSaved: true })).toMatchObject({
      label: '已儲存',
      tone: 'ok',
      alert: false,
    });
  });

  it('shows a faint 未儲存 for unsaved changes', () => {
    expect(saveChipView('dirty', labels, idle)).toMatchObject({ label: '未儲存', faint: true });
  });

  it('shows 儲存中 only once the save has lasted long enough', () => {
    expect(saveChipView('saving', labels, idle)).toMatchObject({ label: '未儲存', saving: false });
    expect(saveChipView('saving', labels, { ...idle, savingLong: true })).toMatchObject({
      label: '儲存中',
      saving: true,
    });
    expect(SAVING_SHOWS_AFTER_MS).toBe(150);
    expect(SAVED_SHOWS_FOR_MS).toBe(2000);
  });

  it('keeps failure and conflict prominent whatever the timers say', () => {
    for (const kind of ['error', 'conflict'] as const) {
      expect(saveChipView(kind, labels, idle)).toMatchObject({ tone: 'bad', alert: true });
    }
  });

  it('keeps the read-only chip', () => {
    expect(saveChipView('readonly', labels, idle)).toMatchObject({ label: '唯讀', alert: false });
  });
});
