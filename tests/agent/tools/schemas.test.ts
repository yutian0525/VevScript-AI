import { describe, it, expect } from 'vitest';
import { TOOL_SCHEMAS } from '../../../agent/tools/schemas';

describe('工具 schema', () => {
  it('恰好 31 个工具（Phase 2 的 9 + Phase 3a 的 7 + Phase 3b 的 3 + Phase 4 的 6 + Skill 的 1 + 脚本检索的 1 + 记忆的 3 + 页面感知 query_page 的 1）', () => {
    const names = TOOL_SCHEMAS.map((s) => s.function.name).sort();
    expect(names).toEqual([
      'click', 'close_page', 'create_script', 'delete_script', 'evaluate_script', 'fill',
      'fill_form', 'get_network_request', 'get_script', 'grep_script', 'hover', 'http_request',
      'list_console_messages', 'list_network_requests', 'list_pages', 'list_scripts', 'load_skill',
      'memory_delete', 'memory_list', 'memory_write',
      'navigate_page', 'new_page', 'press_key', 'query_page', 'scroll', 'select_page',
      'take_screenshot', 'take_snapshot', 'toggle_script', 'update_script', 'wait_for',
    ]);
  });

  it('take_snapshot 有 detail 与 region 参数', () => {
    const s = TOOL_SCHEMAS.find((x) => x.function.name === 'take_snapshot')!;
    const props = (s.function.parameters as { properties: Record<string, unknown> }).properties;
    expect(props.detail).toBeDefined();
    expect(props.region).toBeDefined();
  });

  it('query_page schema 存在且 locator 必填', () => {
    const s = TOOL_SCHEMAS.find((x) => x.function.name === 'query_page')!;
    expect(s).toBeDefined();
    const p = s.function.parameters as { required: string[] };
    expect(p.required).toContain('locator');
  });

  it('load_skill：command 必填 string', () => {
    const t = TOOL_SCHEMAS.find((s) => s.function.name === 'load_skill')!;
    const p = t.function.parameters as { properties: Record<string, { type: string }>; required: string[] };
    expect(p.required).toEqual(['command']);
    expect(p.properties.command!.type).toBe('string');
  });

  it('create_script：source/url 二选一（均可选）；update_script patch.edit 行区间；get_script 行区间参数', () => {
    const create = TOOL_SCHEMAS.find((s) => s.function.name === 'create_script')!;
    const cp = create.function.parameters as { properties: Record<string, { type: string }>; required: string[] };
    // source 与 url 二选一 → 均非强制必填（执行器校验「至少一个」）
    expect(cp.required).toEqual([]);
    expect(cp.properties.source!.type).toBe('string');
    expect(cp.properties.url!.type).toBe('string');

    const update = TOOL_SCHEMAS.find((s) => s.function.name === 'update_script')!;
    const up = update.function.parameters as {
      properties: { patch: { properties: Record<string, { type?: string; required?: string[] }> } };
      required: string[];
    };
    expect(up.required).toEqual(['id', 'patch']);
    expect(up.properties.patch.properties.applyUpdate!.type).toBe('boolean');
    expect(up.properties.patch.properties.edit!.required).toEqual(['startLine', 'endLine', 'text']);

    const get = TOOL_SCHEMAS.find((s) => s.function.name === 'get_script')!;
    const gp = get.function.parameters as { properties: Record<string, { type: string }>; required: string[] };
    expect(gp.required).toEqual(['id']);
    expect(gp.properties.offset!.type).toBe('number');
    expect(gp.properties.limit!.type).toBe('number');
  });

  it('toggle_script：id/enabled 必填', () => {
    const t = TOOL_SCHEMAS.find((s) => s.function.name === 'toggle_script')!;
    const p = t.function.parameters as { required: string[] };
    expect(p.required).toEqual(['id', 'enabled']);
  });

  it('list_console_messages 的 level 枚举', () => {
    const t = TOOL_SCHEMAS.find((s) => s.function.name === 'list_console_messages')!;
    const p = t.function.parameters as { properties: Record<string, { enum?: string[] }> };
    expect(p.properties.level!.enum).toEqual(['log', 'info', 'warn', 'error', 'debug']);
  });

  it('get_network_request 的 requestId 必填', () => {
    const t = TOOL_SCHEMAS.find((s) => s.function.name === 'get_network_request')!;
    const p = t.function.parameters as { required: string[] };
    expect(p.required).toContain('requestId');
  });

  it('list_scripts 描述提及 errorCount 与 grant 状态', () => {
    const l = TOOL_SCHEMAS.find((s) => s.function.name === 'list_scripts')!;
    expect(l.function.description).toContain('errorCount');
    expect(l.function.description).toContain('grantUnsupported');
  });

  it('全部是 function 类型且有描述', () => {
    for (const s of TOOL_SCHEMAS) {
      expect(s.type).toBe('function');
      expect(s.function.description.length).toBeGreaterThan(0);
      expect(s.function.parameters).toHaveProperty('type', 'object');
    }
  });

  it('click 的 uid 是必填 number', () => {
    const click = TOOL_SCHEMAS.find((s) => s.function.name === 'click')!;
    const params = click.function.parameters as { properties: Record<string, { type: string }>; required: string[] };
    expect(params.properties.uid!.type).toBe('number');
    expect(params.required).toContain('uid');
  });

  it('navigate_page 的 type 是枚举', () => {
    const nav = TOOL_SCHEMAS.find((s) => s.function.name === 'navigate_page')!;
    const params = nav.function.parameters as { properties: Record<string, { enum?: string[] }> };
    expect(params.properties.type!.enum).toEqual(['url', 'back', 'forward', 'reload']);
  });

  it('http_request 的 url 必填、method 枚举', () => {
    const t = TOOL_SCHEMAS.find((s) => s.function.name === 'http_request')!;
    const p = t.function.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(p.required).toContain('url');
    expect(p.properties.method!.enum).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
  });

  it('evaluate_script 的 function 必填、world 枚举', () => {
    const t = TOOL_SCHEMAS.find((s) => s.function.name === 'evaluate_script')!;
    const p = t.function.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(p.required).toContain('function');
    expect(p.properties.world!.enum).toEqual(['main', 'isolated']);
  });

  it('new_page 的 url 必填', () => {
    const t = TOOL_SCHEMAS.find((s) => s.function.name === 'new_page')!;
    const p = t.function.parameters as { required: string[] };
    expect(p.required).toContain('url');
  });

  it('grep_script schema：pattern 必填，id/ignoreCase/contextLines/limit 可选', () => {
    const g = TOOL_SCHEMAS.find((s) => s.function.name === 'grep_script')!;
    expect(g).toBeDefined();
    const p = g.function.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(p.required).toEqual(['pattern']);
    expect(Object.keys(p.properties).sort()).toEqual(['contextLines', 'id', 'ignoreCase', 'limit', 'pattern']);
    // 缺省搜全库这条语义必须写进 description（模型据此决定是否传 id）
    expect(g.function.description).toContain('全库');
  });

  it('create_script description：写明长度阈值与骨架不闭合约定', () => {
    const d = TOOL_SCHEMAS.find((s) => s.function.name === 'create_script')!.function.description;
    expect(d).toContain('200 行');
    expect(d).toContain('append');
    expect(d).toContain('})();');
  });

  it('update_script description：写明 append/replace 语义与互斥', () => {
    const u = TOOL_SCHEMAS.find((s) => s.function.name === 'update_script')!;
    const props = (u.function.parameters as { properties: { patch: { properties: Record<string, unknown> } } })
      .properties.patch.properties;
    expect(Object.keys(props).sort()).toEqual(['append', 'applyUpdate', 'edit', 'enabled', 'replace', 'text']);
    expect(u.function.description).toContain('append');
    expect(u.function.description).toContain('replace');
    expect(u.function.description).toContain('balance');
  });

  it('get_script description：说明行号前缀不是内容 + 默认限量', () => {
    const d = TOOL_SCHEMAS.find((s) => s.function.name === 'get_script')!.function.description;
    expect(d).toContain('行号');
    expect(d).toContain('200');
  });

  it('list_scripts description：提及 lines 用于判断读取策略', () => {
    const d = TOOL_SCHEMAS.find((s) => s.function.name === 'list_scripts')!.function.description;
    expect(d).toContain('lines');
  });
});
