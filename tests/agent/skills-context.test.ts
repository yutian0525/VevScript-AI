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
      { name: '网页翻译', command: 'translate', description: '把当前页翻译成中文', createdAt: 1 },
    ]);
    expect(s).toContain('/translate');
    expect(s).toContain('网页翻译');
    expect(s).toContain('把当前页翻译成中文');
    expect(s).toContain('load_skill');
  });

  it('非空 → 清单后追加自写技能的能力引导（先提议、等点头、按 /write-skill 流程）', () => {
    const s = buildSkillsPrompt([{ name: '网页翻译', command: 'translate', description: '把当前页翻译成中文', createdAt: 1 }]);
    for (const t of ['list_skills', 'get_skill', 'create_skill', 'update_skill', 'delete_skill']) {
      expect(s).toContain(t);
    }
    expect(s).toContain('/write-skill');
    expect(s).toContain('等用户点头再写');
    expect(s).toContain('一次性的任务不要写');
  });

  it('空数组 → 空串：引导语随清单一起消失（全停用 = 用户主动关掉技能系统）', () => {
    expect(buildSkillsPrompt([])).toBe('');
  });

  it('ask 模式 → 清单照旧，但收走自写技能引导（那三个工具在 ask 里既不下发也被硬拒）', () => {
    const s = buildSkillsPrompt([{ name: '网页翻译', command: 'translate', description: 'd', createdAt: 1 }], 'ask');
    expect(s).toContain('/translate');
    expect(s).toContain('load_skill'); // 读技能在 ask 合法，仍要教模型用
    for (const t of ['create_skill', 'update_skill', 'delete_skill', '/write-skill']) {
      expect(s).not.toContain(t);
    }
    expect(buildSkillsPrompt([], 'ask')).toBe('');
  });

  it('buildContext(mode: ask) → system prompt 不宣传写技能工具', () => {
    const msgs = buildContext(
      [{ role: 'user', content: 'hi' }],
      { url: '', title: '' },
      { skills: [{ name: 'N', command: 'c', description: 'd', createdAt: 1 }], mode: 'ask' },
    );
    const sys = msgs[0]!.content as string;
    expect(sys).toContain('/c');
    expect(sys).not.toContain('create_skill');
  });

  it('buildContext 带 skills → 技能块进 system；页面信息进末尾易变块', () => {
    const msgs = buildContext(
      [{ role: 'user', content: 'hi' }],
      { url: 'https://x.com', title: 'X' },
      { skills: [{ name: 'N', command: 'c', description: 'd', createdAt: 1 }] },
    );
    const sys = msgs[0]!.content as string;
    const last = msgs[msgs.length - 1]!;
    expect(sys).toContain('/c');
    expect(sys).not.toContain('当前页面');
    expect(String(last.content)).toContain('当前页面');
    expect(String(last.content)).toContain('https://x.com');
  });

  it('buildContext 不带 skills → 不含技能块', () => {
    const msgs = buildContext([{ role: 'user', content: 'hi' }], { url: '', title: '' });
    expect(msgs[0]!.content as string).not.toContain('可用技能');
  });

  it('超过 20 个用户技能 → 只列 20 个 + 溢出行，最新的在前', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      name: `技能${i}`, command: `skill-${String(i).padStart(2, '0')}`, description: 'd', createdAt: i,
    }));
    const s = buildSkillsPrompt(many);
    expect(s).toContain('另有 5 个未列出');
    expect(s).toContain('/skill-24'); // createdAt 最大 → 最新在前
    expect(s).not.toContain('/skill-00'); // 被挤出
  });

  it('内置技能不占名额：4 内置 + 20 用户全部列出，无溢出行', () => {
    const builtins = Array.from({ length: 4 }, (_, i) => ({
      name: `内置${i}`, command: `bi-${i}`, description: 'd', builtin: true, createdAt: i,
    }));
    const users = Array.from({ length: 20 }, (_, i) => ({
      name: `用户${i}`, command: `u-${String(i).padStart(2, '0')}`, description: 'd', createdAt: 100 + i,
    }));
    const s = buildSkillsPrompt([...builtins, ...users]);
    expect(s).toContain('/bi-0');
    expect(s).toContain('/u-19');
    expect(s).not.toContain('未列出');
  });

  it('描述超 60 字符被截断（不硬切，在分隔符处收）', () => {
    const long = '第一件事的说明；第二件事的说明；第三件事的说明；第四件事的补充说明文字还有很多很多需要继续展开描述才能把总长度推过六十个字符的截断线';
    const s = buildSkillsPrompt([{ name: 'N', command: 'c', description: long, createdAt: 1 }]);
    expect(s).toContain('…');
    expect(s).not.toContain('第四件事的补充说明');
  });

  it('20 个技能以内不出现溢出行', () => {
    const s = buildSkillsPrompt([{ name: 'N', command: 'c', description: 'd', createdAt: 1 }]);
    expect(s).not.toContain('未列出');
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
        getSkills: async () => [{ name: '翻译', command: 'translate', description: '简述标记ABC', createdAt: 1 }],
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
        getSkills: async () => [{ name: '翻译', command: 'translate', description: 'd', createdAt: 1 }],
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
        getSkills: async () => [{ name: '翻译', command: 'translate', description: '常驻标记DEF', createdAt: 1 }],
        executeTool: async () => ({ ok: true, data: { result: 'snapshot' } }),
      },
    );
    expect(captured.length).toBe(2);
    for (const p of captured) {
      expect(String(p.messages[0]!.content)).toContain('常驻标记DEF');
    }
  });
});
