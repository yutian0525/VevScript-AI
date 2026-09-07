import { describe, it, expect } from 'vitest';
import { buildContext, truncateMessages, SYSTEM_PROMPT, resolveSystemPrompt } from '../../agent/context';
import type { ChatMessage, ContentPart } from '../../agent/provider/types';

const u = (c: string): ChatMessage => ({ role: 'user', content: c });

describe('context 组装', () => {
  it('第一条是 system，含工具指南与不可信输入声明', () => {
    const msgs = buildContext([u('hi')], { url: 'https://x.com', title: 'X' });
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('不可信');
    expect(msgs[0]!.content).toContain('take_snapshot');
  });

  it('SYSTEM_PROMPT 含「长内容分步写入」通用规则', () => {
    expect(SYSTEM_PROMPT).toContain('骨架');
    expect(SYSTEM_PROMPT).toContain('截断');
  });

  it('注入当前页 URL/title', () => {
    const msgs = buildContext([u('hi')], { url: 'https://x.com', title: '标题' });
    const sys = msgs[0]!.content as string;
    expect(sys).toContain('https://x.com');
    expect(sys).toContain('标题');
  });

  it('历史消息接在 system 之后', () => {
    const msgs = buildContext([u('a'), u('b')], { url: '', title: '' });
    expect(msgs.slice(1).map((m) => m.content)).toEqual(['a', 'b']);
  });

  it('truncateMessages 保留首条 user + 最近 N 条', () => {
    const history = Array.from({ length: 100 }, (_, i) => u(String(i)));
    const kept = truncateMessages(history, 10);
    expect(kept[0]!.content).toBe('0');
    expect(kept[kept.length - 1]!.content).toBe('99');
    expect(kept.length).toBeLessThanOrEqual(11);
  });

  it('历史不超过上限时原样返回', () => {
    const history = [u('a'), u('b')];
    expect(truncateMessages(history, 10)).toEqual(history);
  });

  it('truncateMessages 剥掉窗口头部孤立的 tool 消息（避免 orphaned tool_call）', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '任务' },
      ...Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `f${i}` }) as ChatMessage),
      { role: 'tool', toolCallId: 'orphan', content: 'r' },
      { role: 'assistant', content: '继续' },
    ];
    // keepRecent=2 → 窗口 = 最后2条 [tool, assistant]，头部 tool 应被剥掉
    const kept = truncateMessages(history, 2);
    expect(kept[0]!.role).toBe('user'); // 保留的首条
    expect(kept.slice(1).some((m) => m.role === 'tool')).toBe(false);
    expect(kept[kept.length - 1]!.content).toBe('继续');
  });
});

const img = (tag: string): ChatMessage => ({
  role: 'user',
  content: [{ type: 'text', text: tag }, { type: 'image_url', imageUrl: `data:img,${tag}` }] as ContentPart[],
});

describe('历史图片裁剪', () => {
  it('保留最近 2 条图片，更早的图片替换为文本占位', () => {
    const history = [img('a'), img('b'), img('c'), img('d')];
    const msgs = buildContext(history, { url: '', title: '' });
    const body = msgs.slice(1); // 去掉 system
    const hasImage = (m: ChatMessage) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url');
    const imgCount = body.filter(hasImage).length;
    expect(imgCount).toBe(2); // 只剩 c、d 带图
    const a = body[0]!;
    const aParts = a.content as ContentPart[];
    expect(aParts.some((p) => p.type === 'image_url')).toBe(false);
    expect(aParts.some((p) => p.type === 'text' && p.text.includes('历史截图'))).toBe(true);
  });

  it('图片数 <= 2 时不动', () => {
    const history = [img('a'), img('b')];
    const msgs = buildContext(history, { url: '', title: '' });
    const withImg = msgs.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
    expect(withImg).toHaveLength(2);
  });
});

const page = { url: 'https://x.com', title: 'X' };

describe('buildContext summary 分支', () => {
  it('无 summary 时首条为 system，其后是历史', () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const out = buildContext(history, page);
    expect(out[0]!.role).toBe('system');
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('有 summary 时：system + 前情摘要(user) + coversUpTo 之后的原始消息', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'm0' },
      { role: 'assistant', content: 'm1' },
      { role: 'user', content: 'm2' },
      { role: 'assistant', content: 'm3' },
    ];
    const out = buildContext(history, page, { summary: { text: '前情：做了 m0-m1', coversUpTo: 1 } });
    expect(out[0]!.role).toBe('system');
    expect(out[1]!.role).toBe('user');
    expect(String(out[1]!.content)).toContain('前情：做了 m0-m1');
    // coversUpTo=1 → 保留 index 2,3
    expect(out.slice(2)).toEqual([
      { role: 'user', content: 'm2' },
      { role: 'assistant', content: 'm3' },
    ]);
  });

  it('summary 保留段头部若为孤立 tool 消息则剥离（避免 tool_call_id 悬空）', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'm0' },
      { role: 'tool', toolCallId: 't1', name: 'click', content: 'ok' },
      { role: 'assistant', content: 'm2' },
    ];
    // coversUpTo=0 → 保留段从 index1 起是 tool（悬空），应被剥掉，留 assistant
    const out = buildContext(history, page, { summary: { text: 's', coversUpTo: 0 } });
    const afterSummary = out.slice(2);
    expect(afterSummary[0]!.role).not.toBe('tool');
    expect(afterSummary).toEqual([{ role: 'assistant', content: 'm2' }]);
  });

  it('coversUpTo 越界时保留段为空，只余 system + 摘要', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'm0' },
      { role: 'assistant', content: 'm1' },
    ];
    const out = buildContext(history, page, { summary: { text: 's', coversUpTo: 5 } });
    expect(out).toHaveLength(2);
    expect(out[0]!.role).toBe('system');
    expect(out[1]!.role).toBe('user');
    expect(String(out[1]!.content)).toContain('s');
  });
});

describe('buildContext opts 签名', () => {
  it('opts.summary 生效（等价于旧的第 4 位置参数）', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'm0' },
      { role: 'assistant', content: 'm1' },
      { role: 'user', content: 'm2' },
    ];
    const out = buildContext(history, page, { summary: { text: '前情 S', coversUpTo: 1 } });
    expect(out[0]!.role).toBe('system');
    expect(String(out[1]!.content)).toContain('前情 S');
    expect(out.slice(2)).toEqual([{ role: 'user', content: 'm2' }]);
  });

  it('opts.keepRecent 生效', () => {
    const history: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const, content: `m${i}`,
    }));
    const out = buildContext(history, page, { keepRecent: 2 });
    // system + 首条 + 最近 2 条
    expect(out).toHaveLength(4);
    expect(out[1]).toEqual({ role: 'user', content: 'm0' });
  });

  it('opts.mode 与 opts.skills 同时生效', () => {
    const out = buildContext([], page, {
      mode: 'ask',
      skills: [{ name: 'N', command: 'c', description: 'd' }],
    });
    const sys = String(out[0]!.content);
    expect(sys).toContain('ask（只读问答）');
    expect(sys).toContain('/c');
  });

  it('不传 opts 时行为不变（默认 keepRecent=60 / mode=agent）', () => {
    const out = buildContext([{ role: 'user', content: 'hi' }], page);
    expect(out[0]!.role).toBe('system');
    expect(String(out[0]!.content)).toContain('agent（完整操控）');
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
  });
});

describe('resolveSystemPrompt', () => {
  it('空串 / undefined / 纯空白 → 内置全文', () => {
    expect(resolveSystemPrompt('')).toBe(SYSTEM_PROMPT);
    expect(resolveSystemPrompt(undefined)).toBe(SYSTEM_PROMPT);
    expect(resolveSystemPrompt('   \n  ')).toBe(SYSTEM_PROMPT);
  });

  it('有内容 → 原样返回（不 trim 正文，只用 trim 判空）', () => {
    expect(resolveSystemPrompt('  我的提示词  ')).toBe('  我的提示词  ');
  });
});

describe('buildContext opts.systemPrompt', () => {
  it('传自定义 → system 消息用它，且动态块仍在（页面/技能/模式）', () => {
    const msgs = buildContext([], page, {
      systemPrompt: '【自定义】只听我的',
      skills: [{ name: 'N', command: 'c', description: 'd' }],
      mode: 'ask',
    });
    const sys = String(msgs[0]!.content);
    expect(sys).toContain('【自定义】只听我的');
    expect(sys).not.toContain('你是一个能操控浏览器的 AI 助手');
    expect(sys).toContain('当前页面');
    expect(sys).toContain('/c');
    expect(sys).toContain('ask（只读问答）');
  });

  it('不传 → 用内置全文', () => {
    const sys = String(buildContext([], page)[0]!.content);
    expect(sys).toContain('你是一个能操控浏览器的 AI 助手');
  });
});

describe('buildContext opts.memory', () => {
  const memState = {
    enabled: true,
    writable: true,
    entries: [{ id: 'g1', content: '偏好中文回复', matches: [], updatedAt: 1 }],
  };

  it('记忆块进 system 消息，位置在技能块之后、模式块之前', () => {
    const sys = String(buildContext([], page, {
      skills: [{ name: 'N', command: 'c', description: 'd' }],
      memory: memState,
      mode: 'agent',
    })[0]!.content);
    expect(sys).toContain('偏好中文回复');
    expect(sys.indexOf('可用技能')).toBeLessThan(sys.indexOf('## 记忆'));
    expect(sys.indexOf('## 记忆')).toBeLessThan(sys.indexOf('当前模式'));
  });

  it('不传 memory → 无记忆块', () => {
    expect(String(buildContext([], page)[0]!.content)).not.toContain('## 记忆');
  });

  it('记忆块按当前页 URL 过滤（命中出全文，未命中只出站点清单）', () => {
    const sys = String(buildContext([], { url: 'https://www.bilibili.com/x', title: 'B' }, {
      memory: {
        enabled: true, writable: true,
        entries: [
          { id: 's1', content: 'B 站专属经验', matches: ['*://*.bilibili.com/*'], updatedAt: 1 },
          { id: 'o1', content: 'GitHub 专属经验', matches: ['*://github.com/*'], updatedAt: 1 },
        ],
      },
    })[0]!.content);
    expect(sys).toContain('B 站专属经验');
    expect(sys).not.toContain('GitHub 专属经验');
    expect(sys).toContain('*://github.com/*');
  });

  it('自定义提示词 + 记忆并存（覆盖提示词不影响记忆块）', () => {
    const sys = String(buildContext([], page, {
      systemPrompt: '【自定义】',
      memory: memState,
    })[0]!.content);
    expect(sys).toContain('【自定义】');
    expect(sys).toContain('偏好中文回复');
  });
});
