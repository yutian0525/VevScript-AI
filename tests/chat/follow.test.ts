// tests/chat/follow.test.ts
import { describe, it, expect } from 'vitest';
import { isAtBottom, nextFollow, AT_BOTTOM_SLACK } from '../../components/chat/follow';

/** 造一份滚动量：viewport 500，内容 2000 → 可滚 1500，底部 scrollTop=1500。 */
const m = (scrollTop: number) => ({ scrollTop, scrollHeight: 2000, clientHeight: 500 });
const BOTTOM = 1500;

describe('isAtBottom', () => {
  it('正好贴底 / 余量内 / 余量外', () => {
    expect(isAtBottom(m(BOTTOM))).toBe(true);
    expect(isAtBottom(m(BOTTOM - AT_BOTTOM_SLACK))).toBe(true);
    expect(isAtBottom(m(BOTTOM - AT_BOTTOM_SLACK - 1))).toBe(false);
  });

  it('内容不足一屏（不可滚）算贴底', () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 500 })).toBe(true);
  });
});

describe('nextFollow：关跟随只由用户上滚触发', () => {
  it('用户上滚 → 关跟随', () => {
    expect(nextFollow(BOTTOM, m(900), true)).toBe(false);
  });

  it('从底部只上滚一点（仍在余量内）也关：用户显式表达了要停', () => {
    expect(nextFollow(BOTTOM, m(BOTTOM - 10), true)).toBe(false);
  });

  it('滚回底部 → 自动重开跟随', () => {
    expect(nextFollow(900, m(BOTTOM), false)).toBe(true);
  });

  it('向下滚但还没到底 → 保持原状（不误开也不误关）', () => {
    expect(nextFollow(300, m(600), false)).toBe(false);
    expect(nextFollow(300, m(600), true)).toBe(true);
  });

  it('亚像素回摆（≤1px）不算上滚：平滑动画/橡皮筋不该关跟随', () => {
    expect(nextFollow(600.8, m(600), true)).toBe(true);
  });

  it('位置未变 → 保持原状', () => {
    expect(nextFollow(600, m(600), true)).toBe(true);
    expect(nextFollow(600, m(600), false)).toBe(false);
  });

  describe('点「回到底部」后跟随必须活着（本次修复的回归）', () => {
    it('smooth 下落的每一中间帧都不关跟随', () => {
      let follow = true; // 点击时已置 true
      let prev = 400;
      for (const top of [520, 700, 950, 1200, 1400, BOTTOM]) {
        follow = nextFollow(prev, m(top), follow);
        prev = top;
        expect(follow).toBe(true);
      }
    });

    it('流式中内容还在长、落点短于真底 → 跟随仍开着（下一次增量瞬时补贴底）', () => {
      // 动画按旧的底 1500 落，期间内容长到 2600（真底 2100）
      const grown = { scrollTop: BOTTOM, scrollHeight: 2600, clientHeight: 500 };
      expect(isAtBottom(grown)).toBe(false); // 确实没贴底
      expect(nextFollow(1400, grown, true)).toBe(true); // 但向下滚 → 不关
    });

    it('对照：只看绝对位置的老逻辑会在中间帧关掉跟随', () => {
      expect(isAtBottom(m(700))).toBe(false);
    });
  });

  it('流式瞬时贴底产生的 scroll 事件不关跟随', () => {
    expect(nextFollow(1200, m(BOTTOM), true)).toBe(true);
  });

  it('跟随关闭时内容增长（无 scroll 事件）→ 状态不变，需用户滚回底部才重开', () => {
    const grown = { scrollTop: 900, scrollHeight: 3000, clientHeight: 500 };
    expect(nextFollow(900, grown, false)).toBe(false);
  });
});
