import { THUMBNAIL_FRAME_MAX_BYTES } from '@qiu-creator/contracts';
import { describe, expect, it } from 'vitest';
import { cardFrameRequest } from '../src/main/card-frame.js';

/** QC-061: the main process only forwards a well-formed card frame upload. */

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const META = { version: '0123456789abcdef', source: 'assets/clip.mp4', timeSeconds: 3.5 };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

describe('cardFrameRequest (QC-061)', () => {
  it('builds the thumbnail-frame path with the version, source and time', () => {
    const req = cardFrameRequest(ID, JPEG, META);
    expect(req?.path).toBe(
      `/api/v1/works/${ID}/thumbnail-frame?version=0123456789abcdef&source=assets%2Fclip.mp4&time_seconds=3.5`,
    );
    expect(req?.body).toBe(JPEG);
  });

  it('refuses anything out of bounds', () => {
    expect(cardFrameRequest('../works', JPEG, META)).toBeNull();
    expect(cardFrameRequest(ID, 'not bytes', META)).toBeNull();
    expect(cardFrameRequest(ID, new Uint8Array(0), META)).toBeNull();
    expect(cardFrameRequest(ID, new Uint8Array(THUMBNAIL_FRAME_MAX_BYTES + 1), META)).toBeNull();
    expect(cardFrameRequest(ID, JPEG, { ...META, version: 'zzz' })).toBeNull();
    expect(cardFrameRequest(ID, JPEG, { ...META, source: '' })).toBeNull();
    expect(cardFrameRequest(ID, JPEG, { ...META, timeSeconds: -1 })).toBeNull();
    expect(cardFrameRequest(ID, JPEG, { ...META, timeSeconds: Number.NaN })).toBeNull();
    expect(cardFrameRequest(ID, JPEG, null)).toBeNull();
  });
});
