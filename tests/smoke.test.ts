import { describe, expect, it } from 'vitest';

import { LANIA_VERSION } from '@lania-v/shared';

describe('workspace smoke', () => {
  it('exposes a version constant', () => {
    expect(LANIA_VERSION).toBe('0.0.0');
  });
});
