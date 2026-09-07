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
  content: string;               // encoding=text: 原文；encoding=base64: base64 串
  fetchedAt: number;
  mime?: string;
  encoding?: 'text' | 'base64';  // 旧缓存无此字段 → 惰性视为 'text'
}
type Cache = Record<string, CacheEntry>;

async function readCache(): Promise<Cache> {
  return (await storage.getItem<Cache>(CACHE_KEY)) ?? {};
}

/** content-type 判文本：text/* 或常见文本类 application/*，否则二进制。 */
function isTextContentType(ct: string): boolean {
  return /(^text\/|application\/(json|xml|javascript|x-www-form-urlencoded|ecmascript)|\+json|\+xml|\bcss\b)/i.test(ct);
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

async function fetchResource(url: string): Promise<{ content: string; mime: string; encoding: 'text' | 'base64' }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const mime = (resp.headers.get('content-type') ?? '').split(';')[0]!.trim() || 'application/octet-stream';
    if (isTextContentType(mime)) {
      const text = await resp.text();
      if (text.length > MAX_SINGLE) throw new Error(`超过单文件上限（${MAX_SINGLE} 字符）`);
      return { content: text, mime, encoding: 'text' };
    }
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_SINGLE) throw new Error(`超过单文件上限（${MAX_SINGLE} 字节）`);
    return { content: toBase64(buf), mime, encoding: 'base64' };
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
      const r = await fetchResource(url);
      const content = r.content;
      if (fetched + content.length > MAX_TOTAL) {
        warnings.push(`依赖下载失败：${url}（超过资源总量上限）`);
        continue;
      }
      cache[url] = { content, fetchedAt: now, mime: r.mime, encoding: r.encoding };
      fetched += content.length;
    } catch (e) {
      warnings.push(`依赖下载失败：${url}（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  if (Object.keys(cache).length > 0) await storage.setItem(CACHE_KEY, cache);
  return warnings;
}

/** wrapper 拼装时的资源包：requireCodes 按 meta.requires 顺序、resources name→text（缺段跳过，spec §9.4）。 */
export async function getResourceBundle(script: UserScript): Promise<{ requireCodes: string[]; resources: Record<string, string>; resourceUrls: Record<string, string> }> {
  const cache = await readCache();
  const requires = script.meta?.requires ?? [];
  const resources = script.meta?.resources ?? {};
  const requireCodes: string[] = [];
  for (const url of requires) {
    const hit = cache[url];
    if (hit) requireCodes.push(hit.content); // @require 一律当代码文本（TM 语义）
  }
  const resourceTexts: Record<string, string> = {};
  const resourceUrls: Record<string, string> = {};
  for (const [name, url] of Object.entries(resources)) {
    const hit = cache[url];
    if (!hit) continue;
    const enc = hit.encoding ?? 'text'; // 惰性迁移：旧缓存无字段视为 text
    if (enc === 'text') {
      resourceTexts[name] = hit.content;
      resourceUrls[name] = `data:${hit.mime ?? 'text/plain'};charset=utf-8,${encodeURIComponent(hit.content)}`;
    } else {
      resourceUrls[name] = `data:${hit.mime ?? 'application/octet-stream'};base64,${hit.content}`;
    }
  }
  return { requireCodes, resources: resourceTexts, resourceUrls };
}
