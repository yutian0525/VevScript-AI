// tests/agent/schema-budget.test.ts
// schema 体积预算（spec §5.3）：把「描述又写长了」变成 CI 可见的回归。
//
// 必须基于序列化后的 schema，不能基于 schemas.ts 源码文本——obj() 辅助函数在运行时
// 才生成 type/properties/required/additionalProperties 那层包装，按源码统计会漏算
// 57% 的结构开销（spec §0.1）。
import { describe, it, expect } from 'vitest';
import { getToolSchemas } from '../../agent/tools/registry';

const BUDGET_TOTAL = 15_800;
const BUDGET_PER_TOOL = 1_400;

describe('工具 schema 体积预算', () => {
  const schemas = getToolSchemas('agent', 'full');

  it(`总量不超过 ${BUDGET_TOTAL} 字符`, () => {
    const total = schemas.reduce((a, s) => a + JSON.stringify(s).length, 0);
    expect(total).toBeLessThanOrEqual(BUDGET_TOTAL);
  });

  it(`单个工具不超过 ${BUDGET_PER_TOOL} 字符`, () => {
    const over = schemas
      .map((s) => ({ name: s.function.name, len: JSON.stringify(s).length }))
      .filter((r) => r.len > BUDGET_PER_TOOL);
    expect(over).toEqual([]);
  });

  it('工具数不变（37 个）', () => {
    expect(schemas).toHaveLength(37);
  });
});
