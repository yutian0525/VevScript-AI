// background/storage-manager.ts
// 存储管理编排（spec §3）：分组统计 + 可再生数据清理 + 全量备份导出/导入（全量替换）。
// 全量 dump/clear/remove 只能走裸 browser.storage.local——物理键（无 WXT local: 前缀），
// 分组函数按物理键分类；对照表见 spec §1。

import type {
  StorageCleanScope, StorageGroupKey, StorageUsage, StorageUsageGroup,
} from '../shared/messages';
import type { MessageRouter } from './router';

const PHYS_CONV_INDEX = 'conv-index';
const PHYS_SETTINGS = 'settings';
const PHYS_GM_RESOURCES = 'gm:resources';
const TRACE_SUFFIX = ':trace';

/** 数组型单键域：items = 数组长度而非键数（conv-index 是索引不计条目） */
const ARRAY_KEYS = new Set(['scripts:index', 'skills:index', 'memory:index']);

export function classifyKey(key: string): StorageGroupKey {
  if (key === PHYS_CONV_INDEX) return 'conv';
  if (key.startsWith('conv:')) return key.endsWith(TRACE_SUFFIX) ? 'trace' : 'conv';
  if (key === 'scripts:index') return 'scripts';
  if (key === 'skills:index') return 'skills';
  if (key === 'memory:index') return 'memory';
  if (key === PHYS_SETTINGS) return 'settings';
  if (key === PHYS_GM_RESOURCES) return 'gm-resources';
  if (key === 'gm:permissions' || key === 'gm:seed') return 'gm-auth';
  if (key.startsWith('script-values:')) return 'gm-values';
  if (key === 'scripts:update-state' || key === 'scripts:last-update-check'
    || key === 'ext-update:state' || key === 'ext-update:last-check') return 'update-state';
  return 'other';
}

export function byteLength(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v ?? null)).length;
}

export async function getStorageUsage(): Promise<StorageUsage> {
  const dump = await browser.storage.local.get(null);
  const bytesByKey = new Map<string, number>();
  let totalBytes = 0;
  for (const [k, v] of Object.entries(dump)) {
    const b = byteLength(v);
    bytesByKey.set(k, b);
    totalBytes += b;
  }
  // 累加期 items 必填（StorageUsageGroup.items 可选，只是对外输出的形状）
  const groups = new Map<StorageGroupKey, Required<StorageUsageGroup>>();
  for (const [k, b] of bytesByKey) {
    const g = classifyKey(k);
    const cur = groups.get(g) ?? { group: g, bytes: 0, items: 0 };
    cur.bytes += b;
    if (ARRAY_KEYS.has(k)) cur.items += Array.isArray(dump[k]) ? (dump[k] as unknown[]).length : 0;
    else if (k !== PHYS_CONV_INDEX) cur.items += 1; // conv-index 不计条目
    groups.set(g, cur);
  }
  const groupArr = [...groups.values()].sort((a, b) => b.bytes - a.bytes);

  // trace 按会话明细：convId 取键中段，标题从 conv-index 拼（已删会话 title 置空）
  const convIndex = Array.isArray(dump[PHYS_CONV_INDEX])
    ? (dump[PHYS_CONV_INDEX] as Array<{ id: string; title?: string }>) : [];
  const titleById = new Map(convIndex.map((m) => [m.id, m.title]));
  const traces = [...bytesByKey.entries()]
    .filter(([k]) => classifyKey(k) === 'trace')
    .map(([k, bytes]) => {
      const convId = k.slice('conv:'.length, k.length - TRACE_SUFFIX.length);
      return { convId, title: titleById.get(convId), bytes };
    })
    .sort((a, b) => b.bytes - a.bytes);

  const resCache = (dump[PHYS_GM_RESOURCES] as Record<string, unknown> | undefined) ?? {};
  const gmResources = {
    bytes: bytesByKey.get(PHYS_GM_RESOURCES) ?? 0,
    count: Object.keys(resCache).length,
  };
  return { totalBytes, groups: groupArr, traces, gmResources };
}

// ---------- 清理 / 导出 / 导入（Task 2/3/4 实现，先挂路由空位） ----------

export function initStorageManagerModule(router: MessageRouter): void {
  router.on('STORAGE_USAGE_GET', async () => ({ ok: true, data: await getStorageUsage() }));
}
