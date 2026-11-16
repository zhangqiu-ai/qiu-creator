import type { RevisionSource, WorkStatus } from '@qiu-creator/contracts';
import type { SaveStatus } from './work-session.js';

export const SAVE_STATUS_LABEL: Readonly<Record<SaveStatus, string>> = {
  saved: '已儲存',
  dirty: '未儲存',
  saving: '儲存中',
  error: '儲存失敗',
  conflict: '版本衝突',
};

export const REVISION_SOURCE_LABEL: Readonly<Record<RevisionSource, string>> = {
  create: '建立',
  edit: '編輯',
  external: '外部修改',
  restore: '恢復',
  ai_accepted: 'AI 採用',
};

export const WORK_STATUS_LABEL: Readonly<Record<WorkStatus, string>> = {
  drafting: '創作中',
  in_review: '待審核',
  ready: '待發布',
  published: '已發布',
};

const dateTime = new Intl.DateTimeFormat('zh-TW', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function formatTime(iso: string): string {
  return dateTime.format(new Date(iso));
}
