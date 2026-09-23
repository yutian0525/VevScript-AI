// background/storage-manager.ts
// 存储管理编排（spec §3）：分组统计 + 可再生数据清理 + 全量备份导出/导入（全量替换）。
// 全量 dump/clear/remove 只能走裸 browser.storage.local——物理键（无 WXT local: 前缀），
// 分组函数按物理键分类；对照表见 spec §1。

import type {
  StorageCleanScope, StorageGroupKey, StorageImportResult, StorageUsage, StorageUsageGroup,
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

// ---------- 清理（Task 1-2 已实现） ----------

export async function cleanStorage(scope: StorageCleanScope): Promise<void> {
  if (scope.kind === 'gm-resources') {
    await browser.storage.local.remove(PHYS_GM_RESOURCES); // 下次用到重新预取（7 天 TTL 原语义）
    return;
  }
  if (scope.convIds) {
    await browser.storage.local.remove(scope.convIds.map((id) => `conv:${id}${TRACE_SUFFIX}`));
    return;
  }
  const dump = await browser.storage.local.get(null);
  const traceKeys = Object.keys(dump).filter((k) => classifyKey(k) === 'trace');
  if (traceKeys.length) await browser.storage.local.remove(traceKeys);
}

// ---------- 备份导出（spec §3.3） ----------

interface SettingsLike { provider?: { apiKey?: string } }

export function buildBackup(
  dump: Record<string, unknown>,
  includeApiKey: boolean,
  extVersion: string,
  now = new Date(),
): { json: string; filename: string } {
  // 深拷贝后处理，绝不改调用方的 dump
  const data = JSON.parse(JSON.stringify(dump)) as Record<string, unknown>;
  if (!includeApiKey) {
    const s = data[PHYS_SETTINGS] as SettingsLike | undefined;
    if (s?.provider) s.provider.apiKey = ''; // 剔除 = 置空串：保住 settings 形状
  }
  const meta = {
    app: 'vevscript-ai',
    kind: 'full-backup',
    exportedAt: now.toISOString(),
    extVersion,
    includesApiKey: includeApiKey,
  };
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return {
    json: JSON.stringify({ meta, data }, null, 2),
    filename: `vevscript-ai-backup-v${extVersion}-${ymd}.json`,
  };
}

/** MV3 SW 无 URL.createObjectURL，导出走 data: URL。btoa 只收 Latin1，经 TextEncoder
 *  转字节后分块转二进制串（中文等 BMP 外字符不烂）。 */
export function jsonDataUrl(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:application/json;base64,${btoa(bin)}`;
}

// ---------- 备份导入（spec §3.4，全量替换） ----------

interface BackupMeta { app?: string; kind?: string; includesApiKey?: boolean }

export function parseBackup(text: string): { meta: BackupMeta; data: Record<string, unknown> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是有效的 JSON 文件');
  }
  const obj = parsed as { meta?: BackupMeta; data?: unknown };
  if (obj?.meta?.app !== 'vevscript-ai' || obj?.meta?.kind !== 'full-backup') {
    throw new Error('不是本扩展的完整备份文件（缺少有效文件头）');
  }
  // 数组也过 typeof 'object' 检查——放行会在 clear() 后 set([]) 静默清空全库，这里显式拒绝
  if (typeof obj.data !== 'object' || obj.data === null || Array.isArray(obj.data)) {
    throw new Error('备份缺少 data 数据体');
  }
  return { meta: obj.meta, data: obj.data as Record<string, unknown> };
}

export async function importBackup(payload: string): Promise<StorageImportResult> {
  const { data } = parseBackup(payload); // 校验不过不碰现有数据
  // 配额预检：写入体超 local 配额（留 10% 余量）在 clear() 之前拦下，原数据未动
  const quota = browser.storage.local.QUOTA_BYTES;
  if (JSON.stringify(data).length > quota * 0.9) {
    throw new Error('备份数据超过本地存储配额，已中止导入（原数据未动）');
  }
  const current = await browser.storage.local.get(null);
  // 留存先行：固定含 Key 的完整备份（留存是给自己看的），下载成功才动库
  const backup = buildBackup(current, true, browser.runtime.getManifest().version);
  try {
    await browser.downloads.download({ url: jsonDataUrl(backup.json), filename: backup.filename });
  } catch (e) {
    throw new Error(`留存下载失败，已中止导入：${e instanceof Error ? e.message : String(e)}`);
  }
  const hadKey = Boolean((current[PHYS_SETTINGS] as SettingsLike | undefined)?.provider?.apiKey);
  const importedKey = Boolean((data[PHYS_SETTINGS] as SettingsLike | undefined)?.provider?.apiKey);
  await browser.storage.local.clear();
  try {
    await browser.storage.local.set(data);
  } catch (e) {
    // 走到这步原数据已被 clear() 清空，报错必须指向留存的下载文件
    throw new Error(`导入写入失败且原数据已清空——请用下载目录里的留存备份文件恢复：${e instanceof Error ? e.message : String(e)}`);
  }
  return { apiKeyMissing: hadKey && !importedKey };
}

export function initStorageManagerModule(router: MessageRouter): void {
  router.on('STORAGE_USAGE_GET', async () => ({ ok: true, data: await getStorageUsage() }));
  router.on('STORAGE_CLEAN', async (msg) => {
    const { scope } = msg as unknown as { scope: StorageCleanScope };
    await cleanStorage(scope);
    return { ok: true };
  });
  router.on('STORAGE_EXPORT', async (msg) => {
    const { includeApiKey } = msg as unknown as { includeApiKey: boolean };
    const dump = await browser.storage.local.get(null);
    const b = buildBackup(dump, includeApiKey, browser.runtime.getManifest().version);
    return { ok: true, data: { filename: b.filename, dataUrl: jsonDataUrl(b.json) } };
  });
  router.on('STORAGE_IMPORT', async (msg) => {
    const { payload } = msg as unknown as { payload: string };
    return { ok: true, data: await importBackup(payload) };
  });
}
