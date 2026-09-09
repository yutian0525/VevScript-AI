import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { buildContext, buildSkillsPrompt } from '../../agent/context';
import { runAgentLoop, type LoopDeps } from '../../agent/loop';
import { getConversation } from '../../storage/conversations';
import { saveSkill } from '../../storage/skills';
import { doLoadSkill } from '../../agent/tools/skills-tool';
import type { Provider, StreamEvent, ChatParams } from '../../agent/provider/types';

describe('buildSkillsPrompt / buildContext(skills)', () => {
  it('空数组 → 空串', () => {
    expect(buildSkillsPrompt([])).toBe('');
  });

  it('非空 → 清单格式（含 /command、name、description、引导调用 load_skill）', () => {
    const s = buildSkillsPrompt([
      { name: '网页翻译', command: 'translate', description: '把当前页翻译成中文' },
    ]);
    expect(s).toContain('/translate');
    expect(s).toContain('网页翻译');
    expect(s).toContain('把当前页翻译成中文');
    expect(s).toContain('load_skill');
  });

  it('buildContext 带 skills → 追加到 system prompt 末尾（页面信息仍在）', () => {
    const msgs = buildContext(
      [{ role: 'user', content: 'hi' }],
      { url: 'https://x.com', title: 'X' },
      { skills: [{ name: 'N', command: 'c', description: 'd' }] },
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

  it('/command 就是普通 user 文本：不注入技能正文（正文改由 load_skill 工具拉）', async () => {
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
    // 原文入历史；正文不注入（只剩主 system，含常驻简述）
    const conv = await getConversation('c1');
    expect(conv.messages[0]!.content).toBe('/translate 把这段翻成中文');
    expect(captured[0]!.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(captured[0]!.messages.some((m) => String(m.content).includes('技能正文标记XYZ'))).toBe(false);
    // load_skill 工具在 schema 里可用
    expect(captured[0]!.tools.some((t) => t.function.name === 'load_skill')).toBe(true);
  });

  it('/command 未命中：原样普通文本，无额外 system 消息', async () => {
    const captured: ChatParams[] = [];
    await runAgentLoop({ convId: 'c2', tabId: 1, userMessage: '/nope 内容' }, minimalDeps(captureProvider(captured)));
    expect(captured[0]!.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect((await getConversation('c2')).messages[0]!.content).toBe('/nope 内容');
  });

  it('load_skill 工具结果作为 tool 消息落库并进下一轮上下文（常驻历史）', async () => {
    await saveSkill({
      id: 'k1', name: '翻译', command: 'translate', description: 'd',
      content: '技能正文标记XYZ', enabled: true, createdAt: 1, updatedAt: 1,
    });
    const captured: ChatParams[] = [];
    const scripts: StreamEvent[][] = [
      [
        { type: 'tool-call-delta', index: 0, id: 't1', name: 'load_skill', argsDelta: '{"command":"translate"}' },
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
    const emit = vi.fn();
    await runAgentLoop(
      { convId: 'c4', tabId: 1, userMessage: '/translate 去做' },
      {
        ...minimalDeps(provider),
        emit,
        executeTool: async (name, args) =>
          name === 'load_skill' ? doLoadSkill((args as { command: string }).command) : { ok: true },
      },
    );
    // 正文落库为 tool 消息，且第二轮上下文可见（常驻历史）
    const conv = await getConversation('c4');
    const toolMsg = conv.messages.find((m) => m.role === 'tool' && m.name === 'load_skill');
    expect(String(toolMsg!.content)).toContain('技能正文标记XYZ');
    expect(captured[1]!.messages.some((m) => String(m.content).includes('技能正文标记XYZ'))).toBe(true);
    // 工具卡摘要为「已加载「翻译」」
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-end', name: 'load_skill', summary: '已加载「翻译」' }));
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
