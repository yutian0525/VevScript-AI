// background/gm-permissions.ts
// 「总是允许」跨域授权（spec §4.1 local:gm:permissions，SC PermissionDAO 同款形状）。

import { storage } from 'wxt/utils/storage';

const KEY = 'local:gm:permissions';

interface PermissionsShape {
  [scriptId: string]: { cors: Record<string, 'allow'>; llm?: 'ask' | 'allow' | 'deny' };
}

async function readAll(): Promise<PermissionsShape> {
  return (await storage.getItem<PermissionsShape>(KEY)) ?? {};
}

export async function getAlwaysAllow(scriptId: string, host: string): Promise<boolean> {
  const all = await readAll();
  return all[scriptId]?.cors?.[host] === 'allow';
}

/** 某脚本已「始终允许」的全部跨域主机（白名单视图，spec §3.①）。 */
export async function listAlwaysAllow(scriptId: string): Promise<string[]> {
  const all = await readAll();
  return Object.keys(all[scriptId]?.cors ?? {});
}

export async function setAlwaysAllow(scriptId: string, host: string): Promise<void> {
  const all = await readAll();
  const entry = all[scriptId] ?? { cors: {} };
  entry.cors[host] = 'allow';
  all[scriptId] = entry;
  await storage.setItem(KEY, all);
}

export async function removeScriptPermissions(scriptId: string): Promise<void> {
  const all = await readAll();
  delete all[scriptId];
  await storage.setItem(KEY, all);
}

/** 指定脚本的已授权 host 列表（脚本设置页 XHR 安全区用）。 */
export async function listAllowedHosts(scriptId: string): Promise<string[]> {
  const all = await readAll();
  return Object.keys(all[scriptId]?.cors ?? {});
}

/** 撤销单条授权（幂等：条目不存在时静默成功）。 */
export async function revokeHost(scriptId: string, host: string): Promise<void> {
  const all = await readAll();
  const entry = all[scriptId];
  if (!entry || entry.cors?.[host] === undefined) return;
  delete entry.cors[host];
  if (Object.keys(entry.cors).length === 0) delete all[scriptId];
  await storage.setItem(KEY, all);
}

export type LlmTier = 'ask' | 'allow' | 'deny';

/** 脚本的 LLM 调用权限档（缺省 ask = 每次询问）。 */
export async function getLlmTier(scriptId: string): Promise<LlmTier> {
  const all = await readAll();
  return all[scriptId]?.llm ?? 'ask';
}

export async function setLlmTier(scriptId: string, tier: LlmTier): Promise<void> {
  const all = await readAll();
  const entry = all[scriptId] ?? { cors: {} };
  entry.llm = tier;
  all[scriptId] = entry;
  await storage.setItem(KEY, all);
}
