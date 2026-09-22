// agent/mode.ts
// Agent 行为模式：ask（只读问答）/ agent（完整操控）。
// 三处消费：getToolSchemas(mode) 决定每轮给模型的工具清单；AGENT_MODE_PROMPT 注入 system prompt；
// executeTool 的 mode 守卫兜底拦截（防模型幻觉调用未提供的写工具——工具清单约束靠 prompt 遵循，不等于硬约束）。

/** ask 模式可用的只读工具：ask = 「看页面 + 答问 + 加载技能」。
 *  收走的三类（spec §6.1）：深度观测与依赖它的 get_network_request、wait_for（没有操作可做，
 *  无等待对象）、脚本池读三件（属「写脚本」链路，agent 主场）。
 *  记忆只留 memory_list——写工具随其余写能力一并收走，使 ask 的边界整齐：
 *  完全不产生任何持久化副作用（spec 决策 7，修订 2026-09-07 spec §3.4 的「三工具全留」）。 */
export const ASK_MODE_TOOLS: ReadonlySet<string> = new Set([
  'take_snapshot',          // 读页面结构
  'query_page',             // 定向查询（纯读，与 take_snapshot 同性质）
  'take_screenshot',        // 截图（喂多模态）
  'list_pages',             // 列标签页
  'list_console_messages',
  'list_network_requests',
  'load_skill',             // 取技能正文
  'list_skills',
  'get_skill',
  'memory_list',            // 记忆只读
]);

export type AgentMode = 'ask' | 'agent';

/** 记忆工具的可用档位：off = 不下发、read = 只给 memory_list、full = 三个都给。 */
export type MemoryCap = 'off' | 'read' | 'full';

/** 三个记忆工具。 */
export const MEMORY_TOOLS = new Set(['memory_list', 'memory_write', 'memory_delete']);
/** 其中的写操作。 */
export const MEMORY_WRITE_TOOLS = new Set(['memory_write', 'memory_delete']);

/** 按记忆档位过滤工具 schema。 */
export function filterSchemasForMemory<T extends ToolSchemaLike>(schemas: T[], cap: MemoryCap): T[] {
  if (cap === 'full') return schemas;
  if (cap === 'off') return schemas.filter((s) => !MEMORY_TOOLS.has(s.function.name));
  return schemas.filter((s) => !MEMORY_WRITE_TOOLS.has(s.function.name));
}

/** 记忆工具的硬闸判定：返回拒绝文案，或 null 表示放行。
 *  工具清单已按档位下发，这里是防幻觉调用的兜底（与 ask 模式守卫同一形状）。 */
export function memoryToolDenial(name: string, cap: MemoryCap): string | null {
  if (!MEMORY_TOOLS.has(name)) return null;
  if (cap === 'off') {
    return `记忆功能已在设置中关闭，工具 ${name} 不可用；如需使用请到设置页「AI 记忆」打开总开关`;
  }
  if (cap === 'read' && MEMORY_WRITE_TOOLS.has(name)) {
    return `记忆当前为只读（设置中已关闭「允许 AI 写入」），工具 ${name} 不可用；可以用 memory_list 查看已有记忆`;
  }
  return null;
}

/** 按模式过滤工具 schema。 */
export function filterSchemasForMode(schemas: ToolSchemaLike[], mode: AgentMode): ToolSchemaLike[] {
  if (mode === 'agent') return schemas;
  return schemas.filter((s) => ASK_MODE_TOOLS.has(s.function.name));
}

/** registry 的 executeTool 无关的轻量形状（便于测试注入）。 */
export interface ToolSchemaLike {
  function: { name: string };
}

/** system prompt 附加段：说明当前模式的能力边界。 */
export function modePrompt(mode: AgentMode): string {
  if (mode === 'ask') {
    return `\n\n## 当前模式：ask（只读问答）\n\n你现在处于 ask 模式：只有【只读】工具（看页面结构、截图、读控制台/网络、加载技能、读记忆）。你【不能】点击、填写、导航、开关标签页、执行脚本、发 HTTP 请求、增删改脚本或技能、写入记忆。\n- 回答「这是什么/为什么/怎么样」类问题，解读页面内容、截图、报错与网络请求。\n- 用户要你执行会改动页面或浏览器状态的操作时，说明当前是只读模式，请他切换到 agent 模式（输入框旁的模式下拉框）。\n- 你依然可以用 load_skill 取技能正文来遵循其问答/分析类流程。\n- 本模式不产生任何持久化副作用：不改网页、不改脚本与技能、不写记忆。`;
  }
  return `\n\n## 当前模式：agent（完整操控）\n\n你可以使用全部工具：读页面、点击/填写/导航等页面操作、标签页管理、执行脚本、HTTP 请求、脚本池与技能池读写。先观察（take_snapshot/take_screenshot）再动手；完成任务后用自然语言汇报。`;
}
