import { PlatformSchema } from '@qiu-creator/contracts';
import { describe, expect, it } from 'vitest';
import { getTemplate, PLATFORMS, templates } from '../src/index.js';

describe('platform preview templates', () => {
  it('covers exactly the contract platforms', () => {
    expect([...PLATFORMS].sort()).toEqual([...PlatformSchema.options].sort());
    expect(Object.keys(templates).sort()).toEqual([...PlatformSchema.options].sort());
  });

  it('marks every template as a simulation with a text-only name', () => {
    for (const p of PLATFORMS) {
      const t = getTemplate(p);
      expect(t.platform).toBe(p);
      expect(t.simulated).toBe(true);
      expect(t.displayName.length).toBeGreaterThan(0);
    }
  });
});
