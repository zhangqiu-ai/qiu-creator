import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from '@qiu-creator/api-client';
import {
  AI_NOTICE_VERSION,
  aiConsentNotice,
  type AiJobRecord,
  type CreateAiJobRequest,
} from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { providerError, ProviderError } from '../src/ai/provider.js';
import { BackupIntegrityError, backupFailureReason } from '../src/backups/backup-service.js';
import { fail, FakeAiServer } from './fake-ai.js';
import { startTestServer, type TestServer } from './helpers.js';

/**
 * QC-043: text the service used to write in 繁體中文 now comes with a stable
 * code and parameters, so the app can say it in the interface language. The
 * 繁體 fields stay for API clients.
 */

const servers: TestServer[] = [];
const fakes: FakeAiServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const f of fakes.splice(0)) await f.stop();
});

async function start(): Promise<{ s: TestServer; fake: FakeAiServer }> {
  const fake = new FakeAiServer();
  await fake.start();
  fakes.push(fake);
  const s = await startTestServer({
    ai: { baseUrls: fake.baseUrls(), retryBaseMs: 10, pollMs: 10, timeoutMs: 2000 },
  });
  servers.push(s);
  return { s, fake };
}

const KEY = 'sk-proj-fake-key-0123456789';
const job: CreateAiJobRequest = {
  provider: 'openai',
  action: 'suggest_title',
  input: { system: '你是編輯', prompt: '幫這篇遊記想一個標題', max_output_tokens: 64 },
};

async function failedJob(s: TestServer, id: string): Promise<AiJobRecord> {
  await s.ai.drain();
  return s.client.ai.job(id);
}

describe('AI first-use notice (QC-043)', () => {
  it('names its template and parameters; the version does not depend on language', async () => {
    const { s } = await start();
    const { items } = await s.client.ai.providers();
    expect(items.map((p) => [p.provider, p.notice.template, p.notice.params])).toEqual([
      ['gemini', 'cloud_provider', { name: 'Gemini', company: 'Google' }],
      ['anthropic', 'cloud_provider', { name: 'Claude', company: 'Anthropic' }],
      ['openai', 'cloud_provider', { name: 'GPT', company: 'OpenAI' }],
      ['new-api', 'relay', { name: 'New API', company: expect.any(String) as string }],
    ]);
    for (const p of items) {
      expect(p.notice.version).toBe(AI_NOTICE_VERSION);
      // The 繁體 text stays for API clients.
      expect(p.notice.text).toBe(aiConsentNotice(p.provider));
    }
  });
});

describe('AI job failures (QC-043)', () => {
  it('keeps the code and an untranslated, key-free technical detail', async () => {
    const { s, fake } = await start();
    await s.client.ai.setKey('openai', KEY);
    await s.client.ai.consent('openai', AI_NOTICE_VERSION);
    fake.script('openai', fail('openai', 401, `bad key ${KEY}`));
    const { job: submitted } = await s.client.ai.submit(job);
    const failed = await failedJob(s, submitted.id);
    expect(failed).toMatchObject({ status: 'failed', error_code: 'invalid_key' });
    expect(failed.error_detail).toMatch(/^HTTP 401/);
    expect(failed.error_detail).not.toContain(KEY);
    expect(failed.error).not.toContain(KEY);
    // A retry clears the old detail.
    const overloaded = fail('openai', 500, 'overloaded');
    fake.script('openai', overloaded, overloaded, overloaded);
    await s.client.ai.retry(submitted.id);
    const again = await failedJob(s, submitted.id);
    expect(again).toMatchObject({ status: 'failed', error_code: 'provider_unavailable' });
    expect(again.error_detail).toMatch(/^HTTP 5\d\d/);
  });

  it('builds the detail from the HTTP status and a sanitized provider text', () => {
    const e = providerError(
      'bad_request',
      'model x not found; Bearer abc.def sk-live-0123456789',
      404,
    );
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.code).toBe('bad_request');
    expect(e.detail).toBe('HTTP 404: model x not found; [REDACTED] [REDACTED]');
    expect(providerError('timeout').detail).toBeNull();
    expect(providerError('credential_changed').detail).toBeNull();
    // The 繁體 message is still built for the legacy `error` field.
    expect(e.message).toContain('HTTP 404');
  });
});

describe('backup failures (QC-043)', () => {
  it('classifies errors into reasons', () => {
    const errno = (code: string): Error => Object.assign(new Error(code), { code });
    expect(backupFailureReason(errno('ENOSPC'))).toBe('disk_full');
    expect(backupFailureReason(errno('SQLITE_FULL'))).toBe('disk_full');
    expect(backupFailureReason(errno('EACCES'))).toBe('permission_denied');
    expect(backupFailureReason(errno('SQLITE_CANTOPEN'))).toBe('permission_denied');
    expect(backupFailureReason(errno('SQLITE_CORRUPT_VTAB'))).toBe('integrity_failed');
    expect(backupFailureReason(new BackupIntegrityError('x'))).toBe('integrity_failed');
    expect(backupFailureReason(errno('EIO'))).toBe('io_error');
    expect(backupFailureReason(new Error('?'))).toBe('unknown');
    expect(backupFailureReason('not an error')).toBe('unknown');
  });

  it('a failed daily and manual backup report a reason and the raw detail', async () => {
    const s = await startTestServer({ backups: { schedule: false } });
    servers.push(s);
    const dir = path.join(s.home, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o500);
    try {
      expect(await s.backups.runDaily()).toBeNull();
      const list = await s.client.backups.list();
      expect(list.last_error_reason).toBe('permission_denied');
      expect(list.last_error).not.toBeNull();
      const event = s.db
        .prepare<[], { data: string }>(
          "SELECT data FROM change_log WHERE action = 'backup.failed' ORDER BY seq DESC LIMIT 1",
        )
        .get();
      expect(JSON.parse(event?.data ?? '{}')).toMatchObject({
        kind: 'daily',
        reason: 'permission_denied',
        error: list.last_error,
      });

      const err: unknown = await s.client.backups.create().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      const body = (err as ApiError).body?.error;
      expect((err as ApiError).status).toBe(500);
      expect(body?.code).toBe('backup_failed');
      expect(body?.details?.['reason']).toBe('permission_denied');
      expect(typeof body?.details?.['detail']).toBe('string');
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    // A successful daily backup clears both.
    expect(await s.backups.runDaily()).not.toBeNull();
    expect(await s.client.backups.list()).toMatchObject({
      last_error: null,
      last_error_reason: null,
    });
  });
});
