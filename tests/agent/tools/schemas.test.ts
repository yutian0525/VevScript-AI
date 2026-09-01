import { describe, it, expect } from 'vitest';
import { TOOL_SCHEMAS } from '../../../agent/tools/schemas';

describe('工具 schema', () => {
  it('恰好 16 个工具（Phase 2 的 9 + Phase 3a 的 7）', () => {
    const names = TOOL_SCHEMAS.map((s) => s.function.name).sort();
    expect(names).toEqual([
      'click', 'close_page', 'evaluate_script', 'fill', 'fill_form', 'hover',
      'http_request', 'list_pages', 'navigate_page', 'new_page', 'press_key',
      'scroll', 'select_page', 'take_screenshot', 'take_snapshot', 'wait_for',
    ]);
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
