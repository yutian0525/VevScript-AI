// background/ext-update.ts
// 扩展自身更新检查（纯自分发场景）：Chrome 对「加载已解压」的扩展不做任何自动更新（unpacked 忽略
// update_url，也无 API 自替换本体），这里只负责「发现新版」，替换本体必然人工三步：
// 下载 zip → 解压覆盖原目录（路径即扩展 ID，覆盖保留一切状态）→ chrome://extensions 点刷新。
// 模式整体镜像 scripts-update.ts：latest.json 清单源链 + 冷启动节流检查 + 广播状态。

import { storage } from 'wxt/utils/storage';
import { EXT_UPDATE_STATE_KEY, type ExtUpdateState } from '../shared/types';
import { compareVersions } from '../shared/version';
import { MessageRouter } from './router';

const CHECK_TIMEOUT_MS = 15_000;
/** SW 冷启动节流窗口：距上次检查不足此间隔则跳过（onStartup 在 MV3 不可靠，靠冷启动兜底；scripts-update 同款 12h） */
const STARTUP_CHECK_THROTTLE_MS = 12 * 60 * 60 * 1000; // 12h
/** 上次启动检查时间戳存储键（剥前缀物理键 'ext-update:last-check'） */
const LAST_CHECK_KEY = 'local:ext-update:last-check';

/** latest.json 清单源链：jsDelivr 为主（国内可达，宣传页字体同源依赖），raw.githubusercontent 兜底。
 *  清单由 release 工作流（.github/workflows/release.yml）发版时生成并提交到 main；分支路径缓存 ~12h，
 *  与 12h 检查节流同量级，不影响时效。 */
const MANIFEST_SOURCES = [
  'https://cdn.jsdelivr.net/gh/yutian0525/VevScript-AI@main/latest.json',
  'https://raw.githubusercontent.com/yutian0525/VevScript-AI/main/latest.json',
];

/** latest.json 形状（release 工作流生成；字段都可选宽容解析，version 必需） */
interface UpdateManifest {
  version: string;
  zipUrl?: string;
  notes?: string;
  publishedAt?: string;
}

// ---------- 存取 ----------

export async function readExtUpdateState(): Promise<ExtUpdateState | null> {
  return (await storage.getItem<ExtUpdateState>(EXT_UPDATE_STATE_KEY)) ?? null;
}

async function writeExtUpdateState(state: ExtUpdateState): Promise<void> {
  await storage.setItem(EXT_UPDATE_STATE_KEY, state);
  broadcastState(state);
}

function broadcastState(update: ExtUpdateState | null): void {
  // 无接收方（sidepanel 未开）时 sendMessage 会 reject——fire-and-forget，吞掉即可
  void browser.runtime.sendMessage({ type: 'EXT_UPDATE_STATE', update }).catch(() => {});
}

// ---------- fetch（AbortController 超时，scripts-update 同款） ----------

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

/** 按源链顺序取清单：首个「能取回且解析出 version」的源生效；全失败抛最后一个错误 */
async function fetchManifest(): Promise<UpdateManifest> {
  let lastErr: unknown = new Error('无可用清单源');
  for (const url of MANIFEST_SOURCES) {
    try {
      const text = await fetchText(url, CHECK_TIMEOUT_MS);
      const m = JSON.parse(text) as UpdateManifest;
      if (typeof m.version !== 'string' || !m.version.trim()) throw new Error('清单缺 version');
      return m;
    } catch (e) {
      lastErr = e; // SPA 兜底页/缓存污染/404 都进这里，回退下一源
    }
  }
  throw lastErr;
}

// ---------- 检查 ----------

/** 立即检查一次（无视节流），落库并广播。已知 available 时检查失败不覆盖（别把已知更新藏起来）。 */
export async function checkExtUpdate(): Promise<ExtUpdateState> {
  const local = browser.runtime.getManifest().version;
  let next: ExtUpdateState;
  try {
    const m = await fetchManifest();
    const status = compareVersions(m.version, local) > 0 ? 'available' : 'up-to-date';
    next = { remoteVersion: m.version, checkedAt: Date.now(), status, zipUrl: m.zipUrl, notes: m.notes };
  } catch (e) {
    const prev = await readExtUpdateState();
    if (prev?.status === 'available') return prev;
    next = { remoteVersion: '', checkedAt: Date.now(), status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  await writeExtUpdateState(next);
  return next;
}

// ---------- 冷启动节流检查（scripts-update 同款：onStartup 在 MV3 不可靠，SW 冷启动兜底） ----------

let checkStarted = false;

export async function readLastCheckAt(): Promise<number> {
  return (await storage.getItem<number>(LAST_CHECK_KEY)) ?? 0;
}

/** 启动检查入口：force=true（onStartup/onInstalled 显式信号）无视节流；否则距上次不足窗口则跳过。
 *  同一 SW 生命周期只执行一次真正的检查（节流未到不占用守卫，留给后续 force 调用）。 */
export async function maybeRunStartupExtUpdateCheck(force = false): Promise<void> {
  if (checkStarted) return;
  const last = await readLastCheckAt();
  const due = force || Date.now() - last >= STARTUP_CHECK_THROTTLE_MS;
  if (!due) return;
  checkStarted = true;
  await storage.setItem(LAST_CHECK_KEY, Date.now());
  await checkExtUpdate();
}

/** 测试钩子：重置生命周期守卫（SW 重启即天然重置，测试需手动复位）。 */
export function resetStartupCheckGuardForTest(): void {
  checkStarted = false;
}

// ---------- 路由注册 ----------

export function initExtUpdateModule(router: MessageRouter): void {
  router.on('EXT_UPDATE_GET', async () => ({ ok: true, data: await readExtUpdateState() }));
  router.on('EXT_UPDATE_CHECK', async () => ({ ok: true, data: await checkExtUpdate() }));
}
