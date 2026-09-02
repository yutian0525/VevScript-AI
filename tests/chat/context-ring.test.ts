// tests/chat/context-ring.test.ts
import { describe, it, expect } from 'vitest';
import { dashOffset, RING_CIRCUMFERENCE } from '../../components/chat/context-ring';

describe('ContextRing dashOffset', () => {
  it('ratio 0 → 全空（offset = 周长）', () => {
    expect(dashOffset(0)).toBeCloseTo(RING_CIRCUMFERENCE);
  });
  it('ratio 1 → 全满（offset = 0）', () => {
    expect(dashOffset(1)).toBeCloseTo(0);
  });
  it('ratio 0.5 → 半满', () => {
    expect(dashOffset(0.5)).toBeCloseTo(RING_CIRCUMFERENCE / 2);
  });
});
