import { describe, it, expect } from 'vitest';
import { meterRatio, meterZone, COMPACT_THRESHOLD } from '../../agent/context-meter';

describe('context meter', () => {
  it('占比 = used / window，裁剪到 [0,1]', () => {
    expect(meterRatio(64000, 128000)).toBeCloseTo(0.5);
    expect(meterRatio(200000, 128000)).toBe(1);
    expect(meterRatio(0, 128000)).toBe(0);
  });
  it('window 非法（<=0）时占比 0', () => {
    expect(meterRatio(100, 0)).toBe(0);
  });
  it('used 未知（undefined）时占比 0', () => {
    expect(meterRatio(undefined, 128000)).toBe(0);
  });
  it('档位分界：<80% normal / >=80% warn / >=95% danger', () => {
    expect(meterZone(0.5)).toBe('normal');
    expect(meterZone(0.79)).toBe('normal');
    expect(meterZone(0.8)).toBe('warn');
    expect(meterZone(0.94)).toBe('warn');
    expect(meterZone(0.95)).toBe('danger');
    expect(meterZone(1)).toBe('danger');
  });
  it('压缩阈值 = 0.8', () => {
    expect(COMPACT_THRESHOLD).toBe(0.8);
  });
});
