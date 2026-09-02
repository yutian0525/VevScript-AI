import { describe, it, expect } from 'vitest';
import { TOOL_SCHEMAS } from '../../../agent/tools/schemas';

describe('工具 schema', () => {
  it('恰好 25 个工具（Phase 2 的 9 + Phase 3a 的 7 + Phase 3b 的 3 + Phase 4 的 6）', () => {
    const names = TOOL_SCHEMAS.map((s) => s.function.name).sort();
    expect(names).toEqual([
      'click', 'close_page', 'create_script', 'delete_script', 'evaluate_script', 'fill',
      'fill_form', 'get_network_request', 'get_script', 'hover', 'http_request',
      'list_console_messages', 'list_network_requests', 'list_pages', 'list_scripts',
      'navigate_page', 'new_page', 'press_key', 'scroll', 'select_page',
      'take_screenshot', 'take_snapshot', 'toggle_script', 'update_script', 'wait_for',
    ]);
  });

  it('create_script：source 必填；update_script patch.edit 行区间；get_script 行区间参数', () => {
    const create = TOOL_SCHEMAS.find((s) => s.function.name === 'create_script')!;
    const cp = create.function.parameters as { properties: Record<string, { type: string }>; required: string[] };
    expect(cp.required).toEqual(['source']);
    expect(cp.properties.source!.type).toBe('string');

    const update = TOOL_SCHEMAS.find((s) => s.function.name === 'update_script')!;
    const up = update.function.parameters as {
      properties: { patch: { properties: Record<string, { required?: string[] }> } };
      required: string[];
    };
    expect(up.required).toEqual(['id', 'patch']);
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
});
