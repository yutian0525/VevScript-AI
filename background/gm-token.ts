// background/gm-token.ts
// 桥 token 派生（spec §6）：token = FNV-1a(seed + ':' + scriptId) 的 hex。
// 确定性派生 → SW 重启不换 token → 已开页面的桥不断。seed 存 local:gm:seed，首次生成后持久。

import { storage } from 'wxt/utils/storage';
import { listScripts } from '../storage/scripts';
import { matchUrl } from '../shared/match-pattern';

const SEED_KEY = 'local:gm:seed';

async function getSeed(): Promise<string> {
  const raw = await storage.getItem<string>(SEED_KEY);
  if (typeof raw === 'string' && raw.length >= 16) return raw;
  const seed = crypto.randomUUID().replace(/-/g, '');
  await storage.setItem(SEED_KEY, seed);
  return seed;
}

/** FNV-1a 64 位近似（JS number 精度内 32 位循环两次拼接）——确定性、无依赖、够防猜。 */
function fnv1a(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + Math.imul(input.charCodeAt(i) + i, 0x85ebca6b)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export async function getBridgeToken(scriptId: string): Promise<string> {
  const seed = await getSeed();
  return fnv1a(`${seed}:${scriptId}`);
}

/** 当前 URL 匹配且启用的脚本的 [{ scriptId, token }]（content script 桥宿主索取，spec §6）。 */
export async function bridgeTokensForUrl(url: string): Promise<Array<{ scriptId: string; token: string }>> {
  if (!url) return [];
  const all = await listScripts();
  const matched = all.filter((s) => s.enabled && matchUrl(s.matches, url));
  return Promise.all(matched.map(async (s) => ({ scriptId: s.id, token: await getBridgeToken(s.id) })));
}
