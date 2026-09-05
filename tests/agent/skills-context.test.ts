import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { buildContext, buildSkillsPrompt } from '../../agent/context';
import { runAgentLoop, type LoopDeps } from '../../agent/loop';
import { getConversation } from '../../storage/conversations';
import { saveSkill } from '../../storage/skills';
import type { Provider, StreamEvent, ChatParams } from '../../agent/provider/types';

describe('buildSkillsPrompt / buildContext(skills)', () => {
  it('空数组 → 空串', () => {
    expect(buildSkillsPrompt([])).toBe('');
  });

  it('非空 → 清单格式（含 /command、name、description、遵循提示）', () => {
    const s = buildSkillsPrompt([
      { name: '网页翻译', command: 'translate', description: '把当前页翻译成中文' },
    ]);
    expect(s).toContain('/translate');
    expect(s).toContain('网页翻译');
    expect(s).toContain('把当前页翻译成中文');
    expect(s).toContain('遵循');
  });

  it('buildContext 带 skills → 追加到 system prompt 末尾（页面信息仍在）', () => {
    const msgs = buildContext(
      [{ role: 'user', content: 'hi' }],
      { url: 'https://x.com', title: 'X' },
      60,
      undefined,
      [{ name: 'N', command: 'c', description: 'd' }],
    );
    const sys = msgs[0]!.content as string;
    expect(sys).toContain('/c');
    expect(sys).toContain('当前页面');
  });

  it('buildContext 不带 skills → 不含技能块', () => {
    const msgs = buildContext([{ role: 'user', content: 'hi' }], { url: '', title: '' });
    expect(msgs[0]!.content as string).not.toContain('可用技能');
  });
});

describe('loop 斜杠触发与常驻注入', () => {
  beforeEach(() => fakeBrowser.reset());

  const captureProvider = (captured: ChatParams[]): Provider => ({
    streamChat(p: ChatParams, onEvent: (e: StreamEvent) => void) {
      captured.push(p);
      queueMicrotask(() => onEvent({ type: 'text-delta', text: 'ok' }));
      queueMicrotask(() => onEvent({ type: 'message-done', finishReason: 'stop' }));
      return { cancel: vi.fn() };
    },
  });

  const minimalDeps = (provider: Provider): LoopDeps => ({
    provider,
    executeTool: vi.fn<LoopDeps['executeTool']>(),
    getPageInfo: async () => ({ url: '', title: '' }),
    emit: vi.fn(),
  });

  it('常驻简述注入：getSkills 返回的简述进每轮 system prompt', async () => {
    const captured: ChatParams[] = [];
    await runAgentLoop(
      { convId: 'c6', tabId: 1, userMessage: '普通' },
      {
        ...minimalDeps(captureProvider(captured)),
        getSkills: async () => [{ name: '翻译', command: 'translate', description: '简述标记ABC' }],
      },
    );
    expect(String(captured[0]!.messages[0]!.content)).toContain('简述标记ABC');
  });

  it('getSkills 缺省 → system prompt 不含技能块', async () => {
    const captured: ChatParams[] = [];
    await runAgentLoop({ convId: 'c0', tabId: 1, userMessage: '普通' }, minimalDeps(captureProvider(captured)));
    expect(String(captured[0]!.messages[0]!.content)).not.toContain('可用技能');
  });

  it('/command 触发轮：技能正文作为 system 消息注入（位于 user 原文之前）；历史只存原文', async () => {
    await saveSkill({
      id: 'k1', name: '翻译', command: 'translate', description: 'd',
      content: '技能正文标记XYZ', enabled: true, createdAt: 1, updatedAt: 1,
    });
    const captured: ChatParams[] = [];
    await runAgentLoop(
      { convId: 'c1', tabId: 1, userMessage: '/translate 把这段翻成中文' },
      {
        ...minimalDeps(captureProvider(captured)),
        getSkills: async () => [{ name: '翻译', command: 'translate', description: 'd' }],
      },
    );
    // 历史只存原文，不落库正文
    const conv = await getConversation('c1');
    expect(conv.messages.some((m) => String(m.content).includes('/translate'))).toBe(true);
    expect(conv.messages.some((m) => String(m.content).includes('技能正文标记XYZ'))).toBe(false);

    // 本轮注入：主 system 之后、user 原文之前，有一条含正文的 system 消息
    const msgs = captured[0]!.messages;
    const skillMsg = msgs.find((m) => m.role === 'system' && String(m.content).includes('技能正文标记XYZ'));
    expect(skillMsg).toBeTruthy();
    const userIdx = msgs.findIndex((m) => m.role === 'user' && String(m.content).includes('/translate'));
    expect(msgs.indexOf(skillMsg!)).toBeGreaterThan(0);
    expect(msgs.indexOf(skillMsg!)).toBeLessThan(userIdx);
    expect(String(skillMsg!.content)).toContain('用户附加输入：把这段翻成中文');
  });

  it('/command 命中 → emit skill-loaded（面板据此显示系统提示）', async () => {
    await saveSkill({
      id: 'k9', name: '翻译', command: 'translate', description: 'd',
      content: 'X', enabled: true, createdAt: 1, updatedAt: 1,
    });
    const emit = vi.fn();
    await runAgentLoop(
      { convId: 'c8', tabId: 1, userMessage: '/translate 走' },
      { ...minimalDeps(captureProvider([])), emit, getSkills: async () => [{ name: '翻译', command: 'translate', description: 'd' }] },
    );
    expect(emit).toHaveBeenCalledWith({ type: 'skill-loaded', command: 'translate', name: '翻译' });
  });

  it('/command 未命中 → 不 emit skill-loaded', async () => {
    const emit = vi.fn();
    await runAgentLoop({ convId: 'c10', tabId: 1, userMessage: '/nope x' }, { ...minimalDeps(captureProvider([])), emit });
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'skill-loaded' }));
  });

  it('/command 未命中 → 原样普通文本（无额外 system 消息）', async () => {
    const captured: ChatParams[] = [];
    await runAgentLoop({ convId: 'c2', tabId: 1, userMessage: '/nope 内容' }, minimalDeps(captureProvider(captured)));
    expect(captured[0]!.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect((await getConversation('c2')).messages[0]!.content).toBe('/nope 内容');
  });

  it('disabled 的 skill 不注入正文', async () => {
    await saveSkill({
      id: 'k2', name: '停用', command: 'off', description: 'd',
      content: 'X', enabled: false, createdAt: 1, updatedAt: 1,
    });
    const captured: ChatParams[] = [];
    await runAgentLoop({ convId: 'c5', tabId: 1, userMessage: '/off x' }, minimalDeps(captureProvider(captured)));
    expect(captured[0]!.messages.filter((m) => m.role === 'system')).toHaveLength(1);
  });

  it('非斜杠消息不注入正文', async () => {
    await saveSkill({
      id: 'k1', name: '翻译', command: 'translate', description: 'd',
      content: '技能正文标记XYZ', enabled: true, createdAt: 1, updatedAt: 1,
    });
    const captured: ChatParams[] = [];
    await runAgentLoop({ convId: 'c3', tabId: 1, userMessage: '普通消息' }, {
      ...minimalDeps(captureProvider(captured)),
      getSkills: async () => [{ name: '翻译', command: 'translate', description: 'd' }],
    });
    // 只有主 system（常驻简述并入主 system，不另起一条）
    expect(captured[0]!.messages.filter((m) => m.role === 'system')).toHaveLength(1);
  });

  it('第二轮不再注入正文（仅触发轮）', async () => {
    await saveSkill({
      id: 'k1', name: '翻译', command: 'translate', description: 'd',
      content: '技能正文标记XYZ', enabled: true, createdAt: 1, updatedAt: 1,
    });
    const captured: ChatParams[] = [];
    const scripts: StreamEvent[][] = [
      [
        { type: 'tool-call-delta', index: 0, id: 't1', name: 'take_snapshot', argsDelta: '{}' },
        { type: 'message-done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text-delta', text: '完成' },
        { type: 'message-done', finishReason: 'stop' },
      ],
    ];
    let turn = 0;
    const provider: Provider = {
      streamChat(p, onEvent) {
        captured.push(p);
        const cur = scripts[turn] ?? [];
        turn += 1;
        queueMicrotask(() => { for (const e of cur) onEvent(e); });
        return { cancel: vi.fn() };
      },
    };
    await runAgentLoop(
      { convId: 'c4', tabId: 1, userMessage: '/translate 去做' },
      {
        ...minimalDeps(provider),
        executeTool: async () => ({ ok: true, data: { result: 'snapshot' } }),
      },
    );
    expect(captured.length).toBe(2);
    expect(captured[0]!.messages.some((m) => m.role === 'system' && String(m.content).includes('技能正文标记XYZ'))).toBe(true);
    expect(captured[1]!.messages.some((m) => m.role === 'system' && String(m.content).includes('技能正文标记XYZ'))).toBe(false);
  });

  it('常驻简述第二轮仍在（每轮 buildContext 都注入）', async () => {
    const captured: ChatParams[] = [];
    const scripts: StreamEvent[][] = [
      [
        { type: 'tool-call-delta', index: 0, id: 't1', name: 'take_snapshot', argsDelta: '{}' },
        { type: 'message-done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text-delta', text: '完成' },
        { type: 'message-done', finishReason: 'stop' },
      ],
    ];
    let turn = 0;
    const provider: Provider = {
      streamChat(p, onEvent) {
        captured.push(p);
        const cur = scripts[turn] ?? [];
        turn += 1;
        queueMicrotask(() => { for (const e of cur) onEvent(e); });
        return { cancel: vi.fn() };
      },
    };
    await runAgentLoop(
      { convId: 'c7', tabId: 1, userMessage: '看页面再说' },
      {
        ...minimalDeps(provider),
        getSkills: async () => [{ name: '翻译', command: 'translate', description: '常驻标记DEF' }],
        executeTool: async () => ({ ok: true, data: { result: 'snapshot' } }),
      },
    );
    expect(captured.length).toBe(2);
    for (const p of captured) {
      expect(String(p.messages[0]!.content)).toContain('常驻标记DEF');
    }
  });
});
