// background/gm-resources.ts
// @require/@resource 预取与缓存（spec §9.4）：创建/更新时同步预取（30s 超时、单文件 ≤2MB、总量 ≤10MB），
// 7 天内缓存命中跳过；失败=保存成功但 warning，注入时缺哪段跳哪段。

import { storage } from 'wxt/utils/storage';
import type { UserScript } from '../shared/types';

const CACHE_KEY = 'local:gm:resources';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_SINGLE = 2 * 1024 * 1024;
const MAX_TOTAL = 10 * 1024 * 1024;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheEntry {
  content: string;
  fetchedAt: number;
}
type Cache = Record<string, CacheEntry>;

async function readCache(): Promise<Cache> {
  return (await storage.getItem<Cache>(CACHE_KEY)) ?? {};
}

async function fetchText(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    if (text.length > MAX_SINGLE) throw new Error(`超过单文件上限（${MAX_SINGLE} 字符）`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** 预取脚本声明的全部资源。返回 warnings（空 = 全成功/无资源）。 */
export async function prefetchResources(script: UserScript): Promise<string[]> {
  const requires = script.meta?.requires ?? [];
  const resources = script.meta?.resources ?? {};
  const urls = [...requires, ...Object.values(resources)];
  if (urls.length === 0) return [];

  const cache = await readCache();
  const now = Date.now();
  const warnings: string[] = [];
  let fetched = 0;

  for (const url of urls) {
    const hit = cache[url];
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) continue;
    try {
      const content = await fetchText(url);
      if (fetched + content.length > MAX_TOTAL) {
        warnings.push(`依赖下载失败：${url}（超过资源总量上限）`);
        continue;
      }
      cache[url] = { content, fetchedAt: now };
      fetched += content.length;
    } catch (e) {
      warnings.push(`依赖下载失败：${url}（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  if (Object.keys(cache).length > 0) await storage.setItem(CACHE_KEY, cache);
  return warnings;
}

/** wrapper 拼装时的资源包：requireCodes 按 meta.requires 顺序、resources name→text（缺段跳过，spec §9.4）。 */
export async function getResourceBundle(script: UserScript): Promise<{ requireCodes: string[]; resources: Record<string, string> }> {
  const cache = await readCache();
  const requires = script.meta?.requires ?? [];
  const resources = script.meta?.resources ?? {};
  const requireCodes: string[] = [];
  for (const url of requires) {
    const hit = cache[url];
    if (hit) requireCodes.push(hit.content);
  }
  const resourceTexts: Record<string, string> = {};
  for (const [name, url] of Object.entries(resources)) {
    const hit = cache[url];
    if (hit) resourceTexts[name] = hit.content;
  }
  return { requireCodes, resources: resourceTexts };
}
