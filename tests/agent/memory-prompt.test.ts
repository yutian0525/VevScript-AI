// tests/agent/memory-prompt.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildMemoryPrompt, memoryStateToCap, INJECT_BUDGET_CHARS,
  type MemoryBrief, type MemoryState,
} from '../../agent/memory-prompt';

function brief(over: Partial<MemoryBrief> = {}): MemoryBrief {
  return { id: 'm1', content: '正文', matches: [], updatedAt: 1, ...over };
}

const state = (entries: MemoryBrief[], over: Partial<MemoryState> = {}): MemoryState =>
  ({ enabled: true, writable: true, entries, ...over });

const BILI = 'https://www.bilibili.com/video/BV1';

/** 两段拼合：多数断言关心「记忆块整体」，不关心它落在哪一段。 */
const full = (s: MemoryState, url: string): string => {
  const { stable, volatile } = buildMemoryPrompt(s, url);
  return stable + volatile;
};

describe('buildMemoryPrompt 总开关与冷启动', () => {
  it('enabled:false → 空串（连冷启动文案都不注入）', () => {
    expect(full(state([], { enabled: false }), BILI)).toBe('');
    expect(full(state([brief()], { enabled: false }), BILI)).toBe('');
  });

  it('空库 + 可写 → 冷启动文案，提 memory_write', () => {
    const s = full(state([]), BILI);
    expect(s).toContain('记忆');
    expect(s).toContain('memory_write');
  });

  it('空库 + 只读 → 冷启动文案但不提写工具', () => {
    const s = full(state([], { writable: false }), BILI);
    expect(s).not.toContain('memory_write');
    expect(s).not.toContain('memory_delete');
    expect(s).toContain('memory_list');
  });
});

describe('buildMemoryPrompt 三层分组', () => {
  it('全局记忆（matches 空）始终注入，与 URL 无关', () => {
    const s = full(state([brief({ id: 'g1', content: '偏好中文' })]), '');
    expect(s).toContain('偏好中文');
    expect(s).toContain('全局');
  });

  it('命中当前页的站点记忆出全文', () => {
    const s = full(
      state([brief({ id: 's1', content: '登录在悬浮层', matches: ['*://*.bilibili.com/*'] })]),
      BILI,
    );
    expect(s).toContain('登录在悬浮层');
    expect(s).toContain('*://*.bilibili.com/*');
  });

  it('未命中的记忆只出站点清单，不出正文', () => {
    const s = full(
      state([brief({ id: 'o1', content: '这段正文不该出现', matches: ['*://github.com/*'] })]),
      BILI,
    );
    expect(s).not.toContain('这段正文不该出现');
    expect(s).toContain('*://github.com/*');
    expect(s).toContain('memory_list');
  });

  it('站点清单按 pattern 聚合计数并按条数倒序', () => {
    const s = full(
      state([
        brief({ id: 'a', matches: ['*://github.com/*'] }),
        brief({ id: 'b', matches: ['*://github.com/*'] }),
        brief({ id: 'c', matches: ['*://*.zhihu.com/*'] }),
      ]),
      BILI,
    );
    expect(s).toContain('*://github.com/* (2)');
    expect(s).toContain('*://*.zhihu.com/* (1)');
    expect(s.indexOf('*://github.com/*')).toBeLessThan(s.indexOf('*://*.zhihu.com/*'));
  });

  it('站点清单最多 30 个 pattern，超出附「另有 N 个站点」', () => {
    const entries = Array.from({ length: 35 }, (_, i) =>
      brief({ id: `x${i}`, matches: [`*://site${i}.com/*`] }));
    const s = full(state(entries), BILI);
    expect(s).toContain('另有 5 个站点');
  });

  it('条目格式：[id 作用域] 正文；多 pattern 附「等 N 条」', () => {
    const s = full(
      state([brief({ id: 'ab12cd34', content: 'X', matches: ['*://a.com/*', '*://b.com/*'] })]),
      'https://a.com/x',
    );
    expect(s).toContain('[ab12cd34');
    expect(s).toContain('等 2 条');
  });

  it('全局排在站点记忆之前（阅读顺序）', () => {
    const s = full(
      state([
        brief({ id: 's1', content: '站点条目', matches: ['*://*.bilibili.com/*'] }),
        brief({ id: 'g1', content: '全局条目' }),
      ]),
      BILI,
    );
    expect(s.indexOf('全局条目')).toBeLessThan(s.indexOf('站点条目'));
  });

  it('同层内按 updatedAt 倒序（新的在前）', () => {
    const s = full(
      state([
        brief({ id: 'old', content: '旧条目', updatedAt: 1 }),
        brief({ id: 'new', content: '新条目', updatedAt: 999 }),
      ]),
      '',
    );
    expect(s.indexOf('新条目')).toBeLessThan(s.indexOf('旧条目'));
  });
});

describe('buildMemoryPrompt 预算', () => {
  const long = (n: number) => 'x'.repeat(n);

  it('超预算的条目不注入，附「另有 N 条」提示', () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      brief({ id: `g${i}`, content: long(500), updatedAt: i }));
    const s = full(state(entries), '');
    expect(s).toContain('另有');
    expect(s).toContain('因长度限制未列出');
    expect(s.length).toBeLessThan(INJECT_BUDGET_CHARS * 2);
  });

  it('半预算让渡：只有全局记忆时，可用满整个预算（超过半额）', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      brief({ id: `g${i}`, content: `全局${i}${long(490)}`, updatedAt: i }));
    const s = full(state(entries), '');
    for (let i = 0; i < 10; i++) expect(s).toContain(`全局${i}`);
    expect(s).not.toContain('因长度限制未列出');
  });

  it('全局记忆不会被站点记忆挤掉（各有半额保底）', () => {
    const globals = Array.from({ length: 10 }, (_, i) =>
      brief({ id: `g${i}`, content: `全局${i}${long(490)}`, updatedAt: 100 + i }));
    const sites = Array.from({ length: 10 }, (_, i) =>
      brief({ id: `s${i}`, content: `站点${i}${long(490)}`, matches: ['*://*.bilibili.com/*'], updatedAt: 200 + i }));
    const s = full(state([...globals, ...sites]), BILI);
    expect(s).toContain('全局9');
    expect(s).toContain('站点9');
  });
});

describe('memoryStateToCap', () => {
  it('enabled:false → off；只读 → read；可写 → full', () => {
    expect(memoryStateToCap(state([], { enabled: false }))).toBe('off');
    expect(memoryStateToCap(state([], { writable: false }))).toBe('read');
    expect(memoryStateToCap(state([]))).toBe('full');
  });

  it('enabled:false 优先于 writable', () => {
    expect(memoryStateToCap(state([], { enabled: false, writable: true }))).toBe('off');
  });
});

describe('buildMemoryPrompt 拆 stable / volatile', () => {
  it('说明与用法在 stable，条目在 volatile', () => {
    const { stable, volatile } = buildMemoryPrompt(state([brief({ content: '偏好中文' })]), '');
    expect(stable).toContain('## 记忆');
    expect(stable).toContain('memory_write');
    expect(stable).not.toContain('偏好中文');
    expect(volatile).toContain('偏好中文');
  });

  it('站点清单在 volatile，不在 stable（它是易变的）', () => {
    const { stable, volatile } = buildMemoryPrompt(
      state([brief({ matches: ['*://github.com/*'] })]), BILI);
    expect(stable).not.toContain('*://github.com/*');
    expect(volatile).toContain('*://github.com/*');
  });

  it('空库 → volatile 为空串（尾部块不产生内容）', () => {
    expect(buildMemoryPrompt(state([]), BILI).volatile).toBe('');
  });

  it('未启用 → 两段皆空串', () => {
    expect(buildMemoryPrompt(state([brief()], { enabled: false }), BILI))
      .toEqual({ stable: '', volatile: '' });
  });

  it('只读档的说明在 stable 里就不提写工具', () => {
    const { stable } = buildMemoryPrompt(state([], { writable: false }), BILI);
    expect(stable).not.toContain('memory_write');
    expect(stable).toContain('memory_list');
  });
});
