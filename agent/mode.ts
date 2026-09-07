// agent/mode.ts
// Agent 行为模式：ask（只读问答）/ agent（完整操控）。
// 三处消费：getToolSchemas(mode) 决定每轮给模型的工具清单；AGENT_MODE_PROMPT 注入 system prompt；
// executeTool 的 mode 守卫兜底拦截（防模型幻觉调用未提供的写工具——工具清单约束靠 prompt 遵循，不等于硬约束）。

/** ask 模式可用的只读工具：只看不改。截图/观测/脚本读/技能加载/HTTP GET 之外的写能力全部收走。 */
export const ASK_MODE_TOOLS = new Set([
  'take_snapshot',      // 读页面结构
  'take_screenshot',    // 截图（喂多模态）
  'wait_for',           // 等文本出现（无副作用，轮询读）
  'list_pages',         // 列标签页
  'list_console_messages',
  'list_network_requests',
  'get_network_request',
  'list_scripts',
  'get_script',
  'grep_script',      // 脚本检索（纯读）
  'load_skill',
]);

export type AgentMode = 'ask' | 'agent';

/** 记忆工具的可用档位：off = 不下发、read = 只给 memory_list、full = 三个都给。 */
export type MemoryCap = 'off' | 'read' | 'full';

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
    return `\n\n## 当前模式：ask（只读问答）\n\n你现在处于 ask 模式：只有【只读】工具（看页面结构、截图、读控制台/网络/脚本库、加载技能）。你【不能】点击、填写、导航、开关标签页、执行脚本、发 HTTP 写请求或增删改脚本。\n- 回答「这是什么/为什么/怎么样」类问题，解读页面内容、截图、报错与网络请求。\n- 用户要你执行会改动页面或浏览器状态的操作时，说明当前是只读模式，请他切换到 agent 模式（输入框旁的模式下拉框）。\n- 你依然可以用 load_skill 取技能正文来遵循其问答/分析类流程。`;
  }
  return `\n\n## 当前模式：agent（完整操控）\n\n你可以使用全部工具：读页面、点击/填写/导航等页面操作、标签页管理、执行脚本、HTTP 请求、脚本池管理与技能加载。先观察（take_snapshot/take_screenshot）再动手；完成任务后用自然语言汇报。`;
}
