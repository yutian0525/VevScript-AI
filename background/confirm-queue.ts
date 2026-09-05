// background/confirm-queue.ts
// 通用确认队列（spec §5）：登记/广播/超时/解析，零副作用。enqueueConfirm 返回决策 promise，
// 生产者拿到 decision 后自行处理副作用。单 hub 页排队展示所有待确认项。
import type { ConfirmRequest, ConfirmSpec } from '../shared/confirm';

interface Entry {
  req: ConfirmRequest;
  resolve: (decision: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

// 内部哨兵 decision：生产者把「非自己认识的 decision」一律当 deny 处理。
const TIMEOUT = '__timeout__';
const CLOSED = '__closed__';

const pending = new Map<string, Entry>();
let hubTabId: number | null = null;
// ensureHub 在途单例：同一事件循环内多条 pending 并发触发时复用同一次 ensure，避免开出重复 hub tab。
let ensuring: Promise<void> | null = null;

const HUB_URL = '/confirm.html';

async function focusWindow(windowId: number | undefined): Promise<void> {
  // 把 hub 所在窗口提到前台（多窗口/最小化场景下 tabs.active 不够）。失败不阻断。
  if (windowId == null) return;
  try { await browser.windows.update(windowId, { focused: true }); } catch { /* windows API 不可用或窗口已关 */ }
}

function broadcast(msg: Record<string, unknown>): void {
  void browser.runtime.sendMessage(msg).catch(() => {});
}

/** hub 页复水快照。 */
export function getPending(): ConfirmRequest[] {
  return [...pending.values()].map((e) => e.req);
}

function ensureHub(): Promise<void> {
  // 在途单例：并发调用复用同一次 ensure（首次未回填 hubTabId 前不会重复 create）。
  if (ensuring) return ensuring;
  ensuring = (async () => {
    try {
      // 已记录 hubTabId：校验仍存活（用户可能已关但未触发监听）
      if (hubTabId != null) {
        const existing = await browser.tabs.get(hubTabId).catch(() => null);
        if (existing?.id != null) {
          await browser.tabs.update(hubTabId, { active: true }).catch(() => {});
          await focusWindow(existing.windowId);
          return;
        }
        hubTabId = null;
      }
      const tab = await browser.tabs.create({ url: browser.runtime.getURL(HUB_URL), active: true }).catch(() => null);
      hubTabId = tab?.id ?? null;
      await focusWindow(tab?.windowId);
    } finally {
      ensuring = null;
    }
  })();
  return ensuring;
}

/** 登记 + 广播 CONFIRM_PENDING + 开/聚焦 hub + 起超时。返回决策 promise。 */
export function enqueueConfirm(spec: ConfirmSpec): Promise<string> {
  return new Promise<string>((resolve) => {
    const confirmId = crypto.randomUUID();
    const req: ConfirmRequest = { ...spec, confirmId, createdAt: Date.now() };
    const timer = setTimeout(() => resolveConfirm(confirmId, TIMEOUT), spec.timeoutMs);
    pending.set(confirmId, { req, resolve, timer });
    broadcast({ type: 'CONFIRM_PENDING', confirm: req });
    void ensureHub();
  });
}

/** 解析 promise + 删表 + 清 timer + 广播 CONFIRM_RESOLVED。confirmId 不存在时空操作（幂等）。 */
export function resolveConfirm(confirmId: string, decision: string): void {
  const entry = pending.get(confirmId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(confirmId);
  entry.resolve(decision);
  broadcast({ type: 'CONFIRM_RESOLVED', confirmId });
}

function onHubClosed(tabId: number): void {
  if (tabId !== hubTabId) return;
  hubTabId = null;
  for (const id of [...pending.keys()]) resolveConfirm(id, CLOSED);
}

interface RouterLike {
  on(type: string, handler: (msg: Record<string, unknown>) => unknown): void;
}

export function initConfirmQueue(router: RouterLike): void {
  router.on('CONFIRM_RESOLVE', async (msg) => {
    const { confirmId, decision } = msg as unknown as { confirmId: string; decision: string };
    resolveConfirm(confirmId, decision);
    return { ok: true };
  });
  router.on('CONFIRM_GET_STATE', async () => ({ ok: true, data: { confirms: getPending() } }));
  browser.tabs.onRemoved.addListener(onHubClosed);
}

/** 仅测试用：清空队列与 hub 记录（各用例互不污染）。 */
export function __resetConfirmQueue(): void {
  for (const e of pending.values()) clearTimeout(e.timer);
  pending.clear();
  hubTabId = null;
  ensuring = null;
}
