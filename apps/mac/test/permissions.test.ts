import { describe, expect, it } from 'vitest';
import { APP_INDEX_URL } from '../src/main/app-protocol.js';
import { permissionAllowed } from '../src/main/permissions.js';

describe('renderer web permissions (QC-104)', () => {
  it('lets the app renderer enter HTML fullscreen (video fullscreen button)', () => {
    expect(permissionAllowed('fullscreen', APP_INDEX_URL, null)).toBe(true);
    expect(
      permissionAllowed('fullscreen', 'http://localhost:5173/', 'http://localhost:5173/'),
    ).toBe(true);
  });

  it('denies fullscreen to any other page', () => {
    expect(permissionAllowed('fullscreen', 'https://example.com/', null)).toBe(false);
    expect(permissionAllowed('fullscreen', 'qc-app://other/', null)).toBe(false);
    expect(permissionAllowed('fullscreen', APP_INDEX_URL, 'http://localhost:5173/')).toBe(false);
  });

  it('denies every other permission, even to the app renderer', () => {
    for (const p of ['media', 'notifications', 'geolocation', 'clipboard-read', 'pointerLock']) {
      expect(permissionAllowed(p, APP_INDEX_URL, null)).toBe(false);
    }
  });
});
