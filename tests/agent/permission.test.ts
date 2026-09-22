// tests/agent/permission.test.ts
// 三级确认判定矩阵 + 工具归类完备性（spec §3）。
import { describe, it, expect } from 'vitest';
import { needsConfirm, SENSITIVE_TOOLS, CONFIRM_TIMEOUT_MS } from '../../agent/permission';
import { TOOL_SCHEMAS } from '../../agent/tools/schemas';

const LEVELS = ['all', 'sensitive', 'auto'] as const;

describe('needsConfirm 三档判定', () => {
  it('auto 档：什么都不问', () => {
    expect(needsConfirm('evaluate_script', 'auto')).toBe(false);
    expect(needsConfirm('click', 'auto')).toBe(false);
    expect(needsConfirm('take_snapshot', 'auto')).toBe(false);
  });

  it('只读堆任何档位都免确认', () => {
    for (const level of LEVELS) {
      expect(needsConfirm('take_snapshot', level)).toBe(false);
      expect(needsConfirm('memory_list', level)).toBe(false);
      expect(needsConfirm('load_skill', level)).toBe(false);
    }
  });

  it('sensitive 档：敏感集要问，微操集放行', () => {
    expect(needsConfirm('evaluate_script', 'sensitive')).toBe(true);
    expect(needsConfirm('http_request', 'sensitive')).toBe(true);
    expect(needsConfirm('navigate_page', 'sensitive')).toBe(true);
    expect(needsConfirm('new_page', 'sensitive')).toBe(true);
    expect(needsConfirm('delete_script', 'sensitive')).toBe(true);
    expect(needsConfirm('create_skill', 'sensitive')).toBe(true);
    expect(needsConfirm('click', 'sensitive')).toBe(false);
    expect(needsConfirm('fill', 'sensitive')).toBe(false);
    expect(needsConfirm('press_key', 'sensitive')).toBe(false);
    expect(needsConfirm('select_page', 'sensitive')).toBe(false);
    expect(needsConfirm('memory_write', 'sensitive')).toBe(false);
  });

  it('all 档：除只读外全部要问（含微操）', () => {
    expect(needsConfirm('click', 'all')).toBe(true);
    expect(needsConfirm('fill_form', 'all')).toBe(true);
    expect(needsConfirm('memory_delete', 'all')).toBe(true);
  });

  it('fail-safe：未分类工具在 sensitive 档默认要问', () => {
    expect(needsConfirm('some_future_tool', 'sensitive')).toBe(true);
  });

  it('超时常量 120s（面板倒计时与后台计时共用）', () => {
    expect(CONFIRM_TIMEOUT_MS).toBe(120_000);
  });
});

describe('工具归类完备性（spec §3：三堆覆盖全部分）', () => {
  it('TOOL_SCHEMAS 每个工具：all 档免确认 ⇒ 只读；sensitive 档免确认 ⇒ 微操；其余必须在敏感集', () => {
    expect(TOOL_SCHEMAS.length).toBeGreaterThan(30);
    for (const s of TOOL_SCHEMAS) {
      const name = s.function.name;
      const readonly = !needsConfirm(name, 'all');
      const microp = !readonly && !needsConfirm(name, 'sensitive');
      if (!readonly && !microp) {
        expect(SENSITIVE_TOOLS.has(name), `${name} 未归入敏感集`).toBe(true);
      }
    }
  });

  it('敏感集里没有幻影工具名', () => {
    for (const name of SENSITIVE_TOOLS) {
      expect(TOOL_SCHEMAS.some((s) => s.function.name === name), `${name} 不在 schema 里`).toBe(true);
    }
  });
});
