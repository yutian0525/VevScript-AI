// shared/gm-apis.ts
// GM API 注册表（spec §7）：wrapper 安装、grant 徽标分类（classifyGrants）、docs/gm-api.md 目录的唯一入口。
// impl 分支：snapshot=读注入时直嵌的快照（零桥）；local=当前 world 本地完成；bridge=经事件桥到 SW。
// promiseForm：点形式 GM.xxx 是否返回 Promise（GM_info 的 GM.info 是同引用，非 Promise）。

export type GmImpl = 'snapshot' | 'local' | 'bridge';

export interface GmApiDef {
  impl: GmImpl;
  /** 点形式 GM.xxx 的 Promise 包装（GM_info 的 GM.info 是同引用，非 Promise） */
  promiseForm: boolean;
  /** 对象型 API 的子方法名（仅 GM_cookie）：@grant 一次装齐；点形式 GM.cookie 同引用 */
  objectApi?: string[];
}

export const GM_API_REGISTRY: Record<string, GmApiDef> = {
  GM_info: { impl: 'snapshot', promiseForm: false },
  GM_getValue: { impl: 'snapshot', promiseForm: true },
  GM_setValue: { impl: 'bridge', promiseForm: true },
  GM_deleteValue: { impl: 'bridge', promiseForm: true },
  GM_listValues: { impl: 'snapshot', promiseForm: true },
  GM_addValueChangeListener: { impl: 'local', promiseForm: true },
  GM_addStyle: { impl: 'local', promiseForm: true },
  GM_getResourceText: { impl: 'snapshot', promiseForm: true },
  GM_log: { impl: 'local', promiseForm: false },
  GM_registerMenuCommand: { impl: 'bridge', promiseForm: true },
  GM_setClipboard: { impl: 'bridge', promiseForm: true },
  GM_notification: { impl: 'bridge', promiseForm: true },
  GM_openInTab: { impl: 'bridge', promiseForm: true },
  GM_xmlhttpRequest: { impl: 'bridge', promiseForm: true },
  GM_llmChat: { impl: 'bridge', promiseForm: true },
  // ---- Tier A（零新权限）----
  GM_removeValueChangeListener: { impl: 'local', promiseForm: true },
  GM_getValues: { impl: 'snapshot', promiseForm: true },
  GM_setValues: { impl: 'bridge', promiseForm: true },
  GM_deleteValues: { impl: 'bridge', promiseForm: true },
  GM_addElement: { impl: 'local', promiseForm: true },
  GM_unregisterMenuCommand: { impl: 'bridge', promiseForm: true },
  GM_getResourceURL: { impl: 'snapshot', promiseForm: true },
  GM_getTab: { impl: 'bridge', promiseForm: true },
  GM_saveTab: { impl: 'bridge', promiseForm: true },
  GM_getTabs: { impl: 'bridge', promiseForm: true },
  GM_closeNotification: { impl: 'bridge', promiseForm: true },
  GM_updateNotification: { impl: 'bridge', promiseForm: true },
  // ---- Tier B（需新权限）----
  GM_download: { impl: 'bridge', promiseForm: true },
  GM_cookie: { impl: 'bridge', promiseForm: false, objectApi: ['list', 'set', 'delete'] },
};

/** 特殊 grant 名（非函数，但视为「受支持」——wrapper 直接提供值） */
export const SPECIAL_GRANTS = new Set(['unsafeWindow', 'window.close', 'window.focus', 'window.onurlchange']);

/** grant 列表二分（spec §9.2 徽标精确化）。'none' 与空归空。 */
export function classifyGrants(grants: string[]): { supported: string[]; unsupported: string[] } {
  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const g of grants) {
    if (!g || g === 'none') continue;
    if (GM_API_REGISTRY[g] != null || SPECIAL_GRANTS.has(g)) supported.push(g);
    else unsupported.push(g);
  }
  return { supported, unsupported };
}
