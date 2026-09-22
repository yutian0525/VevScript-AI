// agent/permission.ts
// 三级确认策略（spec §3）：auto（自动放行）/ sensitive（仅敏感）/ all（全部询问）。
// 判定是纯函数；闸门在 loop（spec §6），超时计时与决策往返在 background（spec §7）。

export type ConfirmLevel = 'all' | 'sensitive' | 'auto';

/** 敏感集：任意 JS、跨域网络、导航/开闭标签页、脚本池与技能池写入（写入即代码未来会自动跑）。 */
export const SENSITIVE_TOOLS: ReadonlySet<string> = new Set([
  'evaluate_script', 'http_request', 'navigate_page', 'new_page', 'close_page',
  'create_script', 'update_script', 'delete_script', 'toggle_script',
  'create_skill', 'update_skill', 'delete_skill',
]);

/** 微操集：页面细节交互 + 扩展自己的笔记。只用作 sensitive 档的放行白名单（all 全问、auto 全放，不走这里）。 */
const MICROP_TOOLS: ReadonlySet<string> = new Set([
  'click', 'fill', 'fill_form', 'hover', 'scroll', 'press_key', 'select_page',
  'memory_write', 'memory_delete',
]);

/** 只读集：纯读工具，任何档位都免确认（memory_list 只动扩展本地笔记，同此列）。
 *  独立登记、不再借用 ask 白名单：白名单 2026-09-22 起为上下文瘦身收成 10 个，
 *  比纯读全集少 wait_for、深度观测两件、脚本池读三件——确认判定关心「有无副作用」，
 *  与给模型下发哪些工具是两回事。 */
const READONLY_TOOLS: ReadonlySet<string> = new Set([
  'take_snapshot', 'query_page', 'take_screenshot', 'wait_for',
  'list_pages', 'list_console_messages', 'list_network_requests', 'get_network_request',
  'toggle_deep_observe',
  'list_scripts', 'get_script', 'grep_script',
  'load_skill', 'list_skills', 'get_skill',
  'memory_list',
]);

/** 只读判定：免确认的最高档（连 all 档也放行）。 */
function isReadonlyTool(name: string): boolean {
  return READONLY_TOOLS.has(name);
}

/** 确认等待上限。面板倒计时（until 时间戳）与后台超时计时共用同一常量。 */
export const CONFIRM_TIMEOUT_MS = 120_000;

/** 该工具在该档位下是否需要用户确认。
 *  fail-safe：未分类工具在 sensitive 档默认要问（漏登记的代价是多问一次，不是静默放行）。 */
export function needsConfirm(name: string, level: ConfirmLevel): boolean {
  if (level === 'auto') return false;
  if (isReadonlyTool(name)) return false;
  if (level === 'all') return true;
  return !MICROP_TOOLS.has(name);
}
