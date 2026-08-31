import { describe, it, expect } from 'vitest';
import { TOOL_SCHEMAS } from '../../../agent/tools/schemas';

describe('工具 schema', () => {
  it('恰好 9 个 Phase 2 工具', () => {
    const names = TOOL_SCHEMAS.map((s) => s.function.name).sort();
    expect(names).toEqual(['click', 'fill', 'fill_form', 'hover', 'navigate_page', 'press_key', 'scroll', 'take_snapshot', 'wait_for']);
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
});
