// background/hook-exclusions.ts
// MAIN world hook 敏感站排除名单存储（spec 2026-09-08 §3.1）。
// 命中名单的站点不注入观测 hook（消除扩展指纹，防风控站拒开）；
// 注册同步在 hook-registration.ts，本模块只管名单的存取与校验。
// 存储模块风格仿 gm-permissions.ts：独立 key、纯存取、UI/注册层共用。

import { storage } from 'wxt/utils/storage';
import { isValidMatchPattern } from '../shared/match-pattern';

const KEY = 'local:hook:exclusions';

/** 出厂默认：招聘类强风控站（Boss直聘/拉勾/智联/前程无忧）。
 *  站点反爬会指纹检测 MAIN world hook 包装过的 console/fetch/XHR，命中即拒开。 */
export const DEFAULT_HOOK_EXCLUSIONS: string[] = [
  '*://*.zhipin.com/*',
  '*://*.lagou.com/*',
  '*://*.zhaopin.com/*',
  '*://*.51job.com/*',
];

/** 纯函数：返回 patterns 中的非法条目（UI 添加时预检与 save 前置校验共用）。 */
export function validatePatterns(patterns: string[]): string[] {
  return patterns.filter((p) => !isValidMatchPattern(p));
}

/** 读名单：未存过（用户没改过）时返回出厂默认名单。 */
export async function getHookExclusions(): Promise<string[]> {
  const saved = await storage.getItem<{ patterns: string[] }>(KEY);
  return saved?.patterns ?? DEFAULT_HOOK_EXCLUSIONS;
}

/** 全量覆盖落库。任一条非法则整体拒绝（同步抛错并列出坏条目），不部分落库。
 *  校验同步抛出（非 async），故 UI 预检可 try/catch 直接拿到坏条目文案。 */
export function saveHookExclusions(patterns: string[]): Promise<void> {
  const bad = validatePatterns(patterns);
  if (bad.length > 0) {
    throw new Error(`非法 match pattern：${bad.join('、')}`);
  }
  return storage.setItem(KEY, { patterns });
}

/** 删存储键回默认名单，返回默认名单（UI 刷新用）。 */
export async function resetHookExclusions(): Promise<string[]> {
  await storage.removeItem(KEY);
  return DEFAULT_HOOK_EXCLUSIONS;
}
