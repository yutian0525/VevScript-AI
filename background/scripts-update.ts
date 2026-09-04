// background/scripts-update.ts
// 脚本更新编排（spec §1）：update-state 独立存取 + URL 导入 + 手动检查/应用 + 启动批量检查。
// 复用 handleImport / handleUpdate（text 为唯一真源）；meta 是解析投影 → 更新源经 injectMetaLines 注入文本。

import { storage } from 'wxt/utils/storage';
import { UPDATE_STATE_KEY, type ScriptUpdateState, type UserScript } from '../shared/types';
import { parseUserScript, injectMetaLines } from '../shared/userscript-meta';
import { compareVersions } from '../shared/version';
import { MAX_TEXT_LENGTH, getScript, listScripts } from '../storage/scripts';
import { handleImport, handleUpdate } from './scripts';

const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const CHECK_CONCURRENCY = 4;

export type ScriptUpdateMap = Record<string, ScriptUpdateState>;

// ---------- 存取 ----------

export async function readUpdateStates(): Promise<ScriptUpdateMap> {
  return (await storage.getItem<ScriptUpdateMap>(UPDATE_STATE_KEY)) ?? {};
}

async function writeUpdateStates(map: ScriptUpdateMap): Promise<void> {
  await storage.setItem(UPDATE_STATE_KEY, map);
}

/** 删除单脚本条目（不变量：应用更新成功 / 脚本删除 / 文本更新后由 scripts.ts 调用） */
export async function clearUpdateState(scriptId: string): Promise<void> {
  const map = await readUpdateStates();
  if (!(scriptId in map)) return;
  delete map[scriptId];
  await writeUpdateStates(map);
}

// ---------- fetch（AbortController 超时，gm-resources 同款） ----------

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 更新源（TM 语义回退链） ----------

export function updateCheckUrl(s: UserScript): string | undefined {
  return s.meta?.updateURL ?? s.meta?.downloadURL;
}
export function updateDownloadUrl(s: UserScript): string | undefined {
  return s.meta?.downloadURL ?? s.meta?.updateURL;
}

// ---------- 单脚本检查 ----------

export async function checkScriptUpdate(s: UserScript): Promise<ScriptUpdateState> {
  const url = updateCheckUrl(s);
  if (!url) {
    return { remoteVersion: '', checkedAt: Date.now(), status: 'error', message: '无更新源（@updateURL/@downloadURL）' };
  }
  try {
    const text = await fetchText(url, CHECK_TIMEOUT_MS);
    if (!text.includes('// ==UserScript==')) {
      return { remoteVersion: '', checkedAt: Date.now(), status: 'error', message: '下载内容不是有效脚本' };
    }
    const remote = parseUserScript(text).fields.meta.version ?? '';
    // text 为唯一真源：本地版本从原文解析（meta 是保存时投影，运行时以 text 为准）
    const local = parseUserScript(s.text).fields.meta.version ?? '';
    return {
      remoteVersion: remote,
      checkedAt: Date.now(),
      status: compareVersions(remote, local) > 0 ? 'available' : 'up-to-date',
    };
  } catch (e) {
    return { remoteVersion: '', checkedAt: Date.now(), status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- 启动批量检查（fire-and-forget；并发上限 4） ----------

export async function runStartupUpdateCheck(): Promise<void> {
  const all = await listScripts();
  const targets = all.filter((s) => updateCheckUrl(s) != null);
  if (targets.length === 0) return;
  const prev = await readUpdateStates();
  const results: ScriptUpdateMap = { ...prev };
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CHECK_CONCURRENCY, targets.length) }, async () => {
      while (cursor < targets.length) {
        const s = targets[cursor++]!;
        results[s.id] = await checkScriptUpdate(s);
      }
    }),
  );
  await writeUpdateStates(results);
  await broadcastUpdates(results);
}

async function broadcastUpdates(updates: ScriptUpdateMap): Promise<void> {
  // 无接收方（sidepanel 未开）时 sendMessage 会 reject——fire-and-forget，吞掉即可
  void browser.runtime.sendMessage({ type: 'SCRIPTS_UPDATES', updates }).catch(() => {});
}

// ---------- URL 导入（SCRIPTS_IMPORT_URL） ----------

export async function handleImportUrl(rawUrl: string): Promise<{ script: UserScript; warnings: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('URL 格式无效');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('仅支持 http(s) 直链');
  }
  const text = await fetchText(url.href, DOWNLOAD_TIMEOUT_MS);
  if (text.length > MAX_TEXT_LENGTH) throw new Error(`脚本文本超过上限（${MAX_TEXT_LENGTH} 字符）`);
  if (!text.includes('// ==UserScript==')) throw new Error('下载内容不是有效脚本（缺少 ==UserScript== 头）');
  // 头里没写更新源 → 导入 URL 记为 @updateURL（后续可自动检查更新）；已有则不注入（不覆盖、不重复行）
  const hasUpdateUrl = parseUserScript(text).fields.meta.updateURL != null;
  const withMeta = injectMetaLines(text, { updateURL: hasUpdateUrl ? undefined : url.href });
  return handleImport(withMeta);
}

// ---------- 应用更新（SCRIPTS_APPLY_UPDATE） ----------

export async function handleApplyUpdate(id: string): Promise<UserScript> {
  const existing = await getScript(id);
  if (!existing) throw new Error(`脚本不存在：${id}`);
  const url = updateDownloadUrl(existing);
  if (!url) throw new Error('无更新源（@updateURL/@downloadURL）');
  const text = await fetchText(url, DOWNLOAD_TIMEOUT_MS);
  if (text.length > MAX_TEXT_LENGTH) throw new Error(`脚本文本超过上限（${MAX_TEXT_LENGTH} 字符）`);
  if (!text.includes('// ==UserScript==')) throw new Error('下载内容不是有效脚本（缺少 ==UserScript== 头）');
  // 远端已有更新源键 → 不注入（防覆盖/重复行）；远端缺失 → 补本地值（保留安装源，TM 同此行为）
  const remoteMeta = parseUserScript(text).fields.meta;
  const withMeta = injectMetaLines(text, {
    updateURL: remoteMeta.updateURL != null ? undefined : existing.meta?.updateURL,
    downloadURL: remoteMeta.downloadURL != null ? undefined : existing.meta?.downloadURL,
  });
  const next = await handleUpdate(id, { text: withMeta });
  await clearUpdateState(id); // 版本已对齐，徽标消失
  return next;
}
