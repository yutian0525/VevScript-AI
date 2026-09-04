// tests/chat/slash.test.ts
import { describe, it, expect } from 'vitest';
import { shouldOpenSlash, handleSlashKey, completeSlash } from '../../components/chat/slash';

describe('shouldOpenSlash', () => {
  it('/ 开头且无空格 → 开', () => {
    expect(shouldOpenSlash('/')).toBe(true);
    expect(shouldOpenSlash('/tr')).toBe(true);
  });
  it('/ 后有空格 → 关（附加文本阶段）', () => {
    expect(shouldOpenSlash('/tr ')).toBe(false);
  });
  it('非 / 开头 / 空串 → 关', () => {
    expect(shouldOpenSlash('hello')).toBe(false);
    expect(shouldOpenSlash('')).toBe(false);
  });
});

describe('handleSlashKey', () => {
  const st = (hi: number, count: number) => ({ open: true, hi, count });
  it('ArrowDown/ArrowUp 循环移动高亮', () => {
    expect(handleSlashKey('ArrowDown', st(0, 3))).toEqual({ open: true, hi: 1 });
    expect(handleSlashKey('ArrowDown', st(2, 3))).toEqual({ open: true, hi: 0 });
    expect(handleSlashKey('ArrowUp', st(0, 3))).toEqual({ open: true, hi: 2 });
  });
  it('Enter/Tab → 选中', () => {
    expect(handleSlashKey('Enter', st(1, 3))).toEqual({ open: false, selected: true });
    expect(handleSlashKey('Tab', st(0, 3))).toEqual({ open: false, selected: true });
  });
  it('Escape → 关闭不选中', () => {
    expect(handleSlashKey('Escape', st(1, 3))).toEqual({ open: false, selected: false });
  });
  it('关闭态 / 空候选 → 不处理（null，透传 textarea）', () => {
    expect(handleSlashKey('ArrowDown', { open: false, hi: 0, count: 3 })).toBeNull();
    expect(handleSlashKey('ArrowDown', { open: true, hi: 0, count: 0 })).toBeNull();
  });
  it('其他按键 → null', () => {
    expect(handleSlashKey('a', st(0, 3))).toBeNull();
  });
});

describe('completeSlash', () => {
  it('补全为 /command + 尾随空格', () => {
    expect(completeSlash('translate')).toBe('/translate ');
  });
});
