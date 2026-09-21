// components/debug/tool-tags.ts
// 工具能力域分组（spec §2）：调试台分组 + tag chip 的唯一数据源。
// 缺省兜底 'PAGE'：未来新工具忘登记时按「碰当前页」保守归类（getTag 用）。

export type ToolTag = 'PAGE' | 'TABS' | 'NET' | 'SCRIPTS' | 'SKILLS' | 'MEMORY';

export const TOOL_TAGS: Record<string, ToolTag> = {
  // PAGE(11)：10 个 CS/定位类 + 1 个 SW 直操作当前页（截图）
  take_snapshot: 'PAGE', query_page: 'PAGE', click: 'PAGE', fill: 'PAGE', fill_form: 'PAGE',
  hover: 'PAGE', scroll: 'PAGE', press_key: 'PAGE', wait_for: 'PAGE',
  take_screenshot: 'PAGE', evaluate_script: 'PAGE',
  // TABS(5)：标签页管理与导航
  navigate_page: 'TABS', list_pages: 'TABS', new_page: 'TABS', close_page: 'TABS', select_page: 'TABS',
  // NET(5)：后台 fetch / console / 网络元数据 / CDP 深度观测开关
  http_request: 'NET', list_console_messages: 'NET',
  list_network_requests: 'NET', get_network_request: 'NET',
  toggle_deep_observe: 'NET',
  // SCRIPTS(7)：userScripts CRUD 与启停 + 检索
  list_scripts: 'SCRIPTS', get_script: 'SCRIPTS', grep_script: 'SCRIPTS', create_script: 'SCRIPTS',
  update_script: 'SCRIPTS', delete_script: 'SCRIPTS', toggle_script: 'SCRIPTS',
  // SKILLS(6)：技能正文加载 + 技能池 CRUD（AI 自己写技能）
  load_skill: 'SKILLS',
  list_skills: 'SKILLS', get_skill: 'SKILLS', create_skill: 'SKILLS',
  update_skill: 'SKILLS', delete_skill: 'SKILLS',
  // MEMORY(3)：跨会话长期记忆
  memory_list: 'MEMORY', memory_write: 'MEMORY', memory_delete: 'MEMORY',
};

/** 缺省兜底 PAGE：未登记的新工具保守归「碰当前页」。 */
export function getTag(name: string): ToolTag {
  return TOOL_TAGS[name] ?? 'PAGE';
}

export const GROUPS: ReadonlyArray<{ key: ToolTag; label: string; hint: string }> = [
  { key: 'PAGE', label: '页面操作', hint: 'content script 或 SW 直操作当前页' },
  { key: 'TABS', label: '标签页与导航', hint: 'tabs API / 导航控制' },
  { key: 'NET', label: '网络与观测', hint: '后台 fetch / console / 网络元数据 / CDP 深度观测开关' },
  { key: 'SCRIPTS', label: '脚本池管理', hint: 'userScripts CRUD 与启停' },
  { key: 'SKILLS', label: '技能', hint: '按 command 加载技能正文；技能池 CRUD' },
  { key: 'MEMORY', label: '记忆', hint: '跨会话长期记忆的读写' },
];

/** tag → chip 修饰类（styles.css 六档）。 */
export const CHIP_CLASS: Record<ToolTag, string> = {
  PAGE: 'chip--page', TABS: 'chip--tabs', NET: 'chip--net',
  SCRIPTS: 'chip--script', SKILLS: 'chip--skill', MEMORY: 'chip--memory',
};
