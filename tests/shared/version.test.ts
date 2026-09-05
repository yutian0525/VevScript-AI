import { describe, it, expect } from 'vitest';
import { compareVersions } from '../../shared/version';

describe('compareVersions（spec §1.5）', () => {
  it('数值段比较：1.2.10 > 1.2.9', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
    expect(compareVersions('1.2.9', '1.2.10')).toBe(-1);
  });
  it('相等（含补零对齐）：1.2 === 1.2.0；空串 === 0', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('', '')).toBe(0);
    expect(compareVersions('', '0')).toBe(0);
  });
  it('段数不齐短补零：1.2 < 1.2.1', () => {
    expect(compareVersions('1.2', '1.2.1')).toBe(-1);
  });
  it('非数字段字符串比较：1.2a < 1.2b', () => {
    expect(compareVersions('1.2a', '1.2b')).toBe(-1);
    expect(compareVersions('1.2', '1.2a')).toBe(-1);
  });
  it('空串低于一切具体版本：空串 < 0.0.1（远端无 @version 不误报）', () => {
    expect(compareVersions('', '0.0.1')).toBe(-1);
  });
});
