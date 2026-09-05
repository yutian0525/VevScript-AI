// components/debug/tool-tags.ts
// 工具能力域四分（spec §2）：调试台分组 + tag chip 的唯一数据源。
// 缺省兜底 'PAGE'：未来新工具忘登记时按「碰当前页」保守归类（getTag 用）。

export type ToolTag = 'PAGE' | 'TABS' | 'NET' | 'SCRIPTS' | 'SKILLS';

export const TOOL_TAGS: Record<string, ToolTag> = {
  // PAGE(10)：8 个 CS 工具 + 2 个 SW 直操作当前页（截图/注入脚本）
  take_snapshot: 'PAGE', click: 'PAGE', fill: 'PAGE', fill_form: 'PAGE',
  hover: 'PAGE', scroll: 'PAGE', press_key: 'PAGE', wait_for: 'PAGE',
  take_screenshot: 'PAGE', evaluate_script: 'PAGE',
  // TABS(5)：标签页管理与导航
  navigate_page: 'TABS', list_pages: 'TABS', new_page: 'TABS', close_page: 'TABS', select_page: 'TABS',
  // NET(4)：后台 fetch / console / 网络元数据
  http_request: 'NET', list_console_messages: 'NET',
  list_network_requests: 'NET', get_network_request: 'NET',
  // SCRIPTS(6)：userScripts CRUD 与启停
  list_scripts: 'SCRIPTS', get_script: 'SCRIPTS', create_script: 'SCRIPTS',
  update_script: 'SCRIPTS', delete_script: 'SCRIPTS', toggle_script: 'SCRIPTS',
  // SKILLS(1)：技能正文加载
  load_skill: 'SKILLS',
};

/** 缺省兜底 PAGE：未登记的新工具保守归「碰当前页」。 */
export function getTag(name: string): ToolTag {
  return TOOL_TAGS[name] ?? 'PAGE';
}

export const GROUPS: ReadonlyArray<{ key: ToolTag; label: string; hint: string }> = [
  { key: 'PAGE', label: '页面操作', hint: 'content script 或 SW 直操作当前页' },
  { key: 'TABS', label: '标签页与导航', hint: 'tabs API / 导航控制' },
  { key: 'NET', label: '网络与观测', hint: '后台 fetch / console / 网络元数据' },
  { key: 'SCRIPTS', label: '脚本池管理', hint: 'userScripts CRUD 与启停' },
  { key: 'SKILLS', label: '技能', hint: '按 command 加载技能指令正文' },
];

/** tag → chip 修饰类（styles.css 五档）。 */
export const CHIP_CLASS: Record<ToolTag, string> = {
  PAGE: 'chip--page', TABS: 'chip--tabs', NET: 'chip--net', SCRIPTS: 'chip--script', SKILLS: 'chip--skill',
};
