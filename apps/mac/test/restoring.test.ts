import { ApiError } from '@qiu-creator/api-client';
import { describe, expect, it, vi } from 'vitest';
import type { ProxyRequest, ProxyResponse } from '../src/shared/bridge.js';
import { bridgeFetch } from '../src/renderer/api.js';
import {
  isRestoring,
  noteServiceResponse,
  onRestoringSeen,
  RESTORING_TEXT,
  serviceErrorText,
} from '../src/renderer/restoring.js';

const body = (code: string) => JSON.stringify({ error: { code, message: 'x' } });

function apiError(status: number, code: string): ApiError {
  return new ApiError(
    status,
    { error: { code, message: 'server text' } } as unknown as ConstructorParameters<
      typeof ApiError
    >[1],
    'server text',
  );
}

describe('503 restoring (QC-031)', () => {
  it('words writes refused during a restore for the user', () => {
    expect(isRestoring(apiError(503, 'restoring'))).toBe(true);
    expect(isRestoring(apiError(409, 'restoring'))).toBe(false);
    expect(isRestoring(apiError(503, 'internal_error'))).toBe(false);
    expect(serviceErrorText(apiError(503, 'restoring'))).toBe(RESTORING_TEXT);
    expect(serviceErrorText(apiError(400, 'validation_error'))).toBe('server text');
    expect(serviceErrorText(new TypeError('fetch failed'))).toBe('無法連線到服務');
  });

  it('signals only a 503 whose error code is restoring', () => {
    const seen = vi.fn();
    const off = onRestoringSeen(seen);
    noteServiceResponse(503, body('restoring'));
    noteServiceResponse(503, body('internal_error'));
    noteServiceResponse(409, body('restoring'));
    noteServiceResponse(503, 'restoring: not json');
    noteServiceResponse(503, null);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    noteServiceResponse(503, body('restoring'));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('is noticed for every request that goes through the bridge', async () => {
    const seen = vi.fn();
    const off = onRestoringSeen(seen);
    const request = (req: ProxyRequest): Promise<ProxyResponse> =>
      Promise.resolve({
        status: req.method === 'GET' ? 200 : 503,
        statusText: '',
        headers: { 'content-type': 'application/json' },
        body: req.method === 'GET' ? '{}' : body('restoring'),
      });
    const fetch = bridgeFetch(request);
    await fetch('http://127.0.0.1:7420/api/v1/works', { method: 'GET' });
    expect(seen).not.toHaveBeenCalled();
    const res = await fetch('http://127.0.0.1:7420/api/v1/works', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });
});
