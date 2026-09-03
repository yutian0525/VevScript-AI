// background/gm-permissions.ts
// 「总是允许」跨域授权（spec §4.1 local:gm:permissions，SC PermissionDAO 同款形状）。

import { storage } from 'wxt/utils/storage';

const KEY = 'local:gm:permissions';

interface PermissionsShape {
  [scriptId: string]: { cors: Record<string, 'allow'> };
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
