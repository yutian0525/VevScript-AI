// tests/chat/relative-time.test.ts
import { describe, it, expect } from 'vitest';
import { relativeTime } from '../../components/chat/ConversationMenu';

describe('relativeTime', () => {
  const now = 1_000_000_000_000;
  it('刚刚（<60s）', () => { expect(relativeTime(now - 5_000, now)).toBe('刚刚'); });
  it('分钟', () => { expect(relativeTime(now - 5 * 60_000, now)).toBe('5 分钟前'); });
  it('小时', () => { expect(relativeTime(now - 3 * 3600_000, now)).toBe('3 小时前'); });
  it('天', () => { expect(relativeTime(now - 2 * 86400_000, now)).toBe('2 天前'); });
});
