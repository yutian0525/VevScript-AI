// background/cdp/session.ts
// CDP 会话注册表（设计 §5.1）：附着/脱离、per-tab 状态、冷启动对账自愈。
// 依赖注入 enableDomains / onStateChange（domains.ts 反过来要用本模块的 tabIdForSession，
// 直接互相 import 会成环；background.ts 负责把两者接起来）。
import type { DeepObserveState } from '../../shared/cdp';

/** CDP 协议版本：'0.1' 起兼容，取当前稳定档。 */
export const PROTOCOL_VERSION = '1.3';
/** 被 DevTools 抢占时的原因文案。 */
export const DEVTOOLS_REASON = '页面 DevTools 占用中';

interface SessionRecord { status: 'on' | 'error'; reason?: string; sessions: Set<string> }

const records = new Map<number, SessionRecord>();
const sessionOwner = new Map<string, number>();

let enableDomains: ((tabId: number) => Promise<void>) | null = null;
let onStateChange: ((state: DeepObserveState) => void) | null = null;

export function initCdpSession(deps: {
  enableDomains: (tabId: number) => Promise<void>;
  onStateChange: (state: DeepObserveState) => void;
}): void {
  enableDomains = deps.enableDomains;
  onStateChange = deps.onStateChange;
}

export function getState(tabId: number): DeepObserveState {
  const rec = records.get(tabId);
  if (!rec) return { tabId, status: 'off' };
  return rec.status === 'on' ? { tabId, status: 'on' } : { tabId, status: 'error', reason: rec.reason };
}

export function isAttached(tabId: number): boolean {
  return records.get(tabId)?.status === 'on';
}

export function rememberSession(tabId: number, sessionId: string): void {
  sessionOwner.set(sessionId, tabId);
  records.get(tabId)?.sessions.add(sessionId);
}

export function forgetSession(sessionId: string): void {
  const tabId = sessionOwner.get(sessionId);
  sessionOwner.delete(sessionId);
  if (tabId != null) records.get(tabId)?.sessions.delete(sessionId);
}

export function tabIdForSession(sessionId: string): number | undefined {
  return sessionOwner.get(sessionId);
}

/** 清记录（含该 tab 的全部子 session 映射）。 */
export function forget(tabId: number): void {
  const rec = records.get(tabId);
  if (rec) for (const sid of rec.sessions) sessionOwner.delete(sid);
  records.delete(tabId);
  // rememberSession 在无记录时也会登记映射（如冷启动补记录前的子 session 报到），
  // 记录缺失时上面的集合清理够不着——按归属兜底再扫一遍，防孤儿映射泄漏。
  for (const [sid, owner] of sessionOwner) {
    if (owner === tabId) sessionOwner.delete(sid);
  }
}

function emit(tabId: number): void {
  onStateChange?.(getState(tabId));
}

export async function attach(
  tabId: number,
): Promise<{ ok: true; state: DeepObserveState } | { ok: false; error: string }> {
  if (isAttached(tabId)) return { ok: true, state: getState(tabId) };
  try {
    await browser.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    records.set(tabId, { status: 'error', reason, sessions: new Set() });
    emit(tabId);
    return { ok: false, error: `附着失败：${reason}（若页面已打开 DevTools，请先关闭再重试）` };
  }
  records.set(tabId, { status: 'on', sessions: new Set() });
  try {
    await enableDomains?.(tabId);
  } catch {
    // 域启用失败不脱离：部分域可用仍优于完全不可用。
  }
  emit(tabId);
  return { ok: true, state: getState(tabId) };
}

export async function detach(tabId: number): Promise<void> {
  try {
    await browser.debugger.detach({ tabId });
  } catch {
    // 未附着时 detach 抛「not attached」，视为成功（幂等）。
  }
  forget(tabId);
  emit(tabId);
}

/** 浏览器侧终止会话时的回调（tab 关闭 / 用户开 DevTools / 点信息条取消）。 */
export function onDetached(tabId: number, reason: string): void {
  if (reason === 'target_closed') { forget(tabId); emit(tabId); return; }
  records.set(tabId, { status: 'error', reason: DEVTOOLS_REASON, sessions: new Set() });
  emit(tabId);
}

/**
 * 僵尸态处理：sendCommand 抛「not attached」说明浏览器侧会话已消失而内存记账还在。
 * 清记录并落 error 态；**不自动重附着**——那会与用户开着的 DevTools 抢占成死循环。
 */
export function markZombie(tabId: number): void {
  forget(tabId);
  records.set(tabId, { status: 'error', reason: '调试会话已失效，请重新开启', sessions: new Set() });
  emit(tabId);
}

/**
 * 冷启动对账。附着是浏览器侧状态、跨 SW 重启存活，但本模块的内存记账会丢——
 * 只信内存标志位会得到「以为附着着、实际已断」的僵尸态，之后 sendCommand 抛 "Debugger is not attached"。
 */
export async function reconcile(): Promise<void> {
  let targets: Array<{ type: string; tabId?: number; attached: boolean }>;
  try {
    targets = await browser.debugger.getTargets();
  } catch {
    return; // 对账失败静默，下次冷启动自愈
  }
  const live = new Set(
    targets.filter((t) => t.type === 'page' && t.attached && t.tabId != null).map((t) => t.tabId!),
  );
  for (const tabId of [...records.keys()]) {
    if (!live.has(tabId)) { forget(tabId); emit(tabId); }
  }
  for (const tabId of live) {
    if (isAttached(tabId)) continue;
    // 子 session 映射无从恢复：重新 setAutoAttach 会让子 target 以新 sessionId 重新报到，
    // 旧映射的残留不影响正确性。
    records.set(tabId, { status: 'on', sessions: new Set() });
    try { await enableDomains?.(tabId); } catch { /* 同上：不脱离 */ }
    emit(tabId);
  }
}

/** 仅测试用：清空注册表与依赖。 */
export function __resetCdpSession(): void {
  records.clear();
  sessionOwner.clear();
  enableDomains = null;
  onStateChange = null;
}
