// tests/agent/mode.test.ts
import { describe, it, expect } from 'vitest';
import { ASK_MODE_TOOLS, filterSchemasForMode, modePrompt, type ToolSchemaLike } from '../../agent/mode';
import { getToolSchemas } from '../../agent/tools/registry';
import { executeTool, type ToolCtx } from '../../agent/tools/registry';
import { buildContext } from '../../agent/context';

describe('ASK_MODE_TOOLS 白名单', () => {
  it('只含只读工具：不含任何写操作', () => {
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
});

describe('filterSchemasForMode / getToolSchemas', () => {
  it('agent 模式返回全量 27 个（schemas.ts 当前 27 工具）', () => {
    expect(getToolSchemas('agent')).toHaveLength(27);
    expect(getToolSchemas()).toHaveLength(27); // 缺省 = agent
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
