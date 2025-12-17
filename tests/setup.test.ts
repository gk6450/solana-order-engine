import { describe, it, expect } from 'vitest';

describe('basic sanity', () => {
  it('env USE_MOCK should be allowed (test-only)', () => {
    // tests will set/use USE_MOCK so this just ensures we can read env
    expect(typeof process.env).toBe('object');
  });

  it('deployed sample urls look valid (sanity)', () => {
    const sample = 'https://solana-order-engine.onrender.com';
    expect(sample.startsWith('http')).toBe(true);
  });
});
