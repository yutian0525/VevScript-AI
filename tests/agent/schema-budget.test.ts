// tests/agent/schema-budget.test.ts
// schema 体积预算（spec §5.3）：把「描述又写长了」变成 CI 可见的回归。
//
// 必须基于序列化后的 schema，不能基于 schemas.ts 源码文本——obj() 辅助函数在运行时
// 才生成 type/properties/required/additionalProperties 那层包装，按源码统计会漏算
// 57% 的结构开销（spec §0.1）。
import { describe, it, expect } from 'vitest';
import { getToolSchemas } from '../../agent/tools/registry';

// 总量闸门是**回归绊线**，不是要凑的目标：它钉在 Task 6 实测地板上方一点点，
// 只为拦住「描述又写长了」。数字不是随手取的——
//   结构管道（desc 全置空后的序列化结果）           ≈8,889  ← 与「不减工具数」无关，动不了
//   "description": 键与语法开销（37 工具 + 134 参数） ≈2,394  ← 动不了
//   工具级 + 参数级 description 文本               ≈5,895  ← Task 6 已压到只剩操作要点与填参语义
//   合计                                          17,177
// spec §5.3 原写 15,800（≈ 散文只留 45%），但它与 §5.1 的「留 参数级 description」
// 自相矛盾：参数级只剩 2,080 且全是模型填参的唯一依据。两条规则冲突时以 §5.1 的
// 保留清单为准（那是用户「不要为省字节降低工具选择质量」的明确取舍），故闸门随之移动。
// 17,400 = 17,177 + 223 余量：够 Task 7 给 list_skills 加 query 参数（约 60）后仍留约 160，
// 避免合法新增撞闸。**不要**为了「把数字压回 15,800」而删操作要点或参数语义。
const BUDGET_TOTAL = 17_400;
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
