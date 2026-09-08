// stores/hook-exclusions.ts
// 敏感站点排除名单的前端请求发送器（sendScriptsRequest 同款惯例）。
import type { HookExclusionsRequest } from '../shared/messages';

export async function sendHookExclusionsRequest<T = unknown>(req: HookExclusionsRequest): Promise<T> {
  return (await browser.runtime.sendMessage(req)) as T;
}
