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
