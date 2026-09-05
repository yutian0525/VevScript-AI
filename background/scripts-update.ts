// background/scripts-update.ts
// 脚本更新编排（spec §1）：update-state 独立存取 + URL 导入 + 手动检查/应用 + 启动批量检查。
// 复用 handleImport / handleUpdate（text 为唯一真源）；meta 是解析投影 → 更新源经 injectMetaLines 注入文本。

import { storage } from 'wxt/utils/storage';
import { UPDATE_STATE_KEY, type ScriptSource, type ScriptUpdateState, type UserScript } from '../shared/types';
import { parseUserScript, injectMetaLines } from '../shared/userscript-meta';
import { compareVersions } from '../shared/version';
import { MAX_TEXT_LENGTH, getScript, listScripts } from '../storage/scripts';
import { handleImport, handleUpdate } from './scripts';

const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const CHECK_CONCURRENCY = 4;

/** 上次启动检查时间戳存储键（SW 冷启动节流用，剥前缀物理键 'scripts:last-update-check'）。 */
const LAST_CHECK_KEY = 'local:scripts:last-update-check';
/** SW 冷启动节流窗口：距上次检查不足此间隔则跳过（onStartup 在 MV3 不可靠，靠冷启动兜底）。 */
const STARTUP_CHECK_THROTTLE_MS = 12 * 60 * 60 * 1000; // 12h

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

// ---------- 冷启动节流检查（修复：onStartup 在 MV3 不可靠，SW 冷启动兜底） ----------
// runtime.onStartup 仅在浏览器带扩展「冷启动」那一刻触发一次；开发模式（unpacked）几乎不触发，
// SW 因空闲被回收后被其它事件（打开侧边栏、页面导航…）唤醒时也不会补触发——于是「浏览器开着却没检查」。
// 兜底：每次 SW 冷启动（含被任意事件唤醒）都进本函数，按上次检查时间戳节流（默认 12h）决定是否真的查。
// 同一 SW 生命周期内只跑一次（checkStarted 守卫），避免顶层调用与 onStartup 事件重复触发。

let checkStarted = false;

export async function readLastCheckAt(): Promise<number> {
  return (await storage.getItem<number>(LAST_CHECK_KEY)) ?? 0;
}

/** 启动检查入口：force=true（onInstalled/onStartup 显式信号）无视节流；否则距上次不足窗口则跳过。
 *  同一 SW 生命周期只执行一次真正的检查（节流未到不占用守卫，留给后续 force 调用）。 */
export async function maybeRunStartupUpdateCheck(force = false): Promise<void> {
  if (checkStarted) return;
  const last = await readLastCheckAt();
  const due = force || Date.now() - last >= STARTUP_CHECK_THROTTLE_MS;
  if (!due) return; // 节流未到：不设守卫，后续 force 调用仍可执行
  checkStarted = true;
  await storage.setItem(LAST_CHECK_KEY, Date.now());
  await runStartupUpdateCheck();
}

/** 测试钩子：重置生命周期守卫（SW 重启即天然重置，测试需手动复位）。 */
export function resetStartupCheckGuardForTest(): void {
  checkStarted = false;
}

// ---------- URL 导入（SCRIPTS_IMPORT_URL） ----------

export async function handleImportUrl(
  rawUrl: string,
  source: ScriptSource = 'import',
): Promise<{ script: UserScript; warnings: string[] }> {
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
  // source 决定归属：UI/SCRIPTS_IMPORT_URL 用 'import'；AI create_script 从 url 导入传 'agent'
  return handleImport(withMeta, undefined, source);
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
