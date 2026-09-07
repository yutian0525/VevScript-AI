// tests/agent/mode.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ASK_MODE_TOOLS, filterSchemasForMode, modePrompt, type ToolSchemaLike } from '../../agent/mode';
import { getToolSchemas } from '../../agent/tools/registry';
import { executeTool, type ToolCtx } from '../../agent/tools/registry';
import { buildContext } from '../../agent/context';

describe('ASK_MODE_TOOLS 白名单', () => {
  it('只含只读工具：不含任何写操作', () => {
    // 注意：memory_write / memory_delete 虽名为「写」，但刻意在白名单内——
    // ask 的语义是「不改网页/浏览器状态」，记忆只改扩展自己的本地笔记（spec §3.4）。
    // 不要把它们加进下面这个列表。
    const writeTools = ['click', 'fill', 'fill_form', 'hover', 'scroll', 'press_key', 'navigate_page',
      'new_page', 'close_page', 'select_page', 'evaluate_script', 'http_request',
      'create_script', 'update_script', 'delete_script', 'toggle_script'];
    for (const t of writeTools) {
      expect(ASK_MODE_TOOLS.has(t)).toBe(false);
    }
  });

  it('包含读页面/观测/脚本读/技能工具', () => {
    for (const t of ['take_snapshot', 'take_screenshot', 'wait_for', 'list_pages',
      'list_console_messages', 'list_network_requests', 'get_network_request',
      'list_scripts', 'get_script', 'load_skill']) {
      expect(ASK_MODE_TOOLS.has(t)).toBe(true);
    }
  });

  it('grep_script 属只读，ask 模式可用', () => {
    expect(ASK_MODE_TOOLS.has('grep_script')).toBe(true);
  });

  it('记忆三工具在 ask 白名单内（本地笔记不算改浏览器状态）', () => {
    for (const t of ['memory_list', 'memory_write', 'memory_delete']) {
      expect(ASK_MODE_TOOLS.has(t)).toBe(true);
    }
  });
});

describe('filterSchemasForMode / getToolSchemas', () => {
  it('agent 模式返回全量 30 个（schemas.ts 当前 30 工具）', () => {
    expect(getToolSchemas('agent')).toHaveLength(30);
    expect(getToolSchemas()).toHaveLength(30); // 缺省 = agent
  });

  it('ask 模式只返回白名单内的 schema', () => {
    const ask = getToolSchemas('ask');
    expect(ask.length).toBe(ASK_MODE_TOOLS.size);
    for (const s of ask) {
      expect(ASK_MODE_TOOLS.has(s.function.name)).toBe(true);
    }
  });

  it('filterSchemasForMode 纯函数与 registry 过滤一致', () => {
    const all: ToolSchemaLike[] = getToolSchemas().map((s) => ({ function: { name: s.function.name } }));
    expect(filterSchemasForMode(all, 'ask').map((s) => s.function.name).sort())
      .toEqual([...ASK_MODE_TOOLS].sort());
  });
});

describe('executeTool 模式守卫', () => {
  const baseCtx: Omit<ToolCtx, 'mode'> = { tabId: 1, sessionId: 'c1', signal: new AbortController().signal };

  it('ask 模式拒绝白名单外的工具（click）', async () => {
    const r = await executeTool('click', { uid: 1 }, { ...baseCtx, mode: 'ask' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ask');
  });

  it('ask 模式拒绝写脚本工具（create_script）', async () => {
    const r = await executeTool('create_script', { source: 'x' }, { ...baseCtx, mode: 'ask' });
    expect(r.ok).toBe(false);
  });

  it('agent 模式（缺省）不拦：走正常执行链（未知工具报未知而非模式拒）', async () => {
    const r = await executeTool('click', { uid: 1 }, baseCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain('模式');
  });
});

describe('modePrompt', () => {
  it('ask 模式提示只读边界与切换指引', () => {
    const p = modePrompt('ask');
    expect(p).toContain('ask');
    expect(p).toContain('只读');
    expect(p).toContain('agent');
  });

  it('agent 模式提示完整能力', () => {
    expect(modePrompt('agent')).toContain('agent');
  });

  it('buildContext 把模式段并入 system 消息', () => {
    const msgs = buildContext([], { url: 'https://x.com', title: 'X' }, { mode: 'ask' });
    const sys = msgs[0]!;
    expect(sys.role).toBe('system');
    expect(String(sys.content)).toContain('ask（只读问答）');
  });
});

describe('记忆 cap 过滤与守卫', () => {
  beforeEach(() => fakeBrowser.reset());

  it("cap='full' → 三个记忆工具都在", () => {
    const names = getToolSchemas('agent', 'full').map((s) => s.function.name);
    expect(names).toContain('memory_list');
    expect(names).toContain('memory_write');
    expect(names).toContain('memory_delete');
  });

  it("cap='read' → 只留 memory_list", () => {
    const names = getToolSchemas('agent', 'read').map((s) => s.function.name);
    expect(names).toContain('memory_list');
    expect(names).not.toContain('memory_write');
    expect(names).not.toContain('memory_delete');
  });

  it("cap='off' → 三个都不下发，其余工具不受影响", () => {
    const names = getToolSchemas('agent', 'off').map((s) => s.function.name);
    expect(names).not.toContain('memory_list');
    expect(names).not.toContain('memory_write');
    expect(names).not.toContain('memory_delete');
    expect(names).toContain('take_snapshot');
    expect(names).toHaveLength(27);
  });

  it('缺省 cap = full（调试台等既有调用点不受影响）', () => {
    expect(getToolSchemas('agent')).toHaveLength(30);
  });

  it('cap 与 mode 二维叠加：ask + read', () => {
    const names = getToolSchemas('ask', 'read').map((s) => s.function.name);
    expect(names).toContain('memory_list');
    expect(names).not.toContain('memory_write');
    expect(names).not.toContain('click');
  });

  it("executeTool 硬闸：cap='off' 拒全部记忆工具", async () => {
    const ctx: ToolCtx = { tabId: 1, sessionId: 's', signal: new AbortController().signal, memory: 'off' };
    for (const t of ['memory_list', 'memory_write', 'memory_delete']) {
      const r = await executeTool(t, { content: 'x', id: 'y' }, ctx);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error).toContain('记忆');
    }
  });

  it("executeTool 硬闸：cap='read' 拒写、放读", async () => {
    const ctx: ToolCtx = { tabId: 1, sessionId: 's', signal: new AbortController().signal, memory: 'read' };
    const w = await executeTool('memory_write', { content: 'x' }, ctx);
    expect(w.ok).toBe(false);
    const d = await executeTool('memory_delete', { id: 'y' }, ctx);
    expect(d.ok).toBe(false);
    const l = await executeTool('memory_list', {}, ctx);
    expect(l.ok).toBe(true);
  });

  it('不传 memory cap → 不设限（默认 full）', async () => {
    const ctx: ToolCtx = { tabId: 1, sessionId: 's', signal: new AbortController().signal };
    expect((await executeTool('memory_list', {}, ctx)).ok).toBe(true);
  });
});
