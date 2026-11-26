import { describe, expect, it } from 'vitest';
import { readAssetText } from '../src/main/assets.js';

const ID = '0b9a4c8e-6a6b-4f3e-9c7d-2a1b3c4d5e6f';
const conn = { baseUrl: 'http://127.0.0.1:7420', token: 'test-token' };

function fakeFetch(body: Uint8Array<ArrayBuffer> | null, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const doFetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return { doFetch, calls };
}

describe('reading a text asset for the reader (QC-108)', () => {
  it('asks the service for the start of the stream with the token and a byte range', async () => {
    const { doFetch, calls } = fakeFetch(new TextEncoder().encode('# 標題\n正文'));
    const text = await readAssetText(doFetch, conn, ID.toUpperCase(), 1024);
    expect(text).toEqual({ text: '# 標題\n正文', truncated: false });
    expect(calls[0]?.url).toBe(`http://127.0.0.1:7420/api/v1/assets/${ID}/stream`);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer test-token');
    expect(headers['range']).toBe('bytes=0-1024');
    expect(calls[0]?.init?.redirect).toBe('error');
  });

  it('cuts a longer file at the limit without a broken last character', async () => {
    // 「中」 is 3 bytes; a 4-byte limit falls inside the second one.
    const { doFetch } = fakeFetch(new TextEncoder().encode('中文字'));
    expect(await readAssetText(doFetch, conn, ID, 4)).toEqual({ text: '中', truncated: true });
  });

  it('refuses anything but an asset id and gives null when the file cannot be read', async () => {
    const { doFetch, calls } = fakeFetch(new TextEncoder().encode('x'));
    expect(await readAssetText(doFetch, conn, '../../etc/passwd')).toBeNull();
    expect(await readAssetText(doFetch, conn, 42)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await readAssetText(fakeFetch(null, 404).doFetch, conn, ID)).toBeNull();
    const failing = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    expect(await readAssetText(failing, conn, ID)).toBeNull();
  });
});
