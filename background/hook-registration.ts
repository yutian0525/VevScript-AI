// background/hook-registration.ts
// MAIN world hook 的动态注册同步（spec 2026-09-08 §3.2）。
// hook.content.ts 用 registration: 'runtime'，manifest 不再声明，注册责任在本模块：
// matches=<all_urls> + excludeMatches=敏感站名单，diff 同步（同 scripts.ts 期望注册集自愈模式）。

import { getHookExclusions } from './hook-exclusions';

export const HOOK_REGISTRATION_ID = 'hook-observe';

// ---------- scripting.registerContentScripts 局部接口（Chrome 96+）----------
// 项目里 browser 走 WXT auto-import，Browser.scripting.RegisteredContentScript 的 js 类型是
// string[]（file 路径裸串），而 hook 用 registration:'runtime' 产物需按 [{file}] 形状登记；
// 为避免与全局类型冲突，仿 scripts.ts 的 UserScriptsApi 局部接口模式自定形状。
interface RegisteredContentScript {
  id: string;
  matches: string[];
  excludeMatches?: string[];
  js: Array<{ file: string }>;
  runAt: 'document_start' | 'document_end' | 'document_idle';
  world: 'MAIN' | 'ISOLATED';
  allFrames: boolean;
  persistAcrossSessions: boolean;
}

interface ScriptingApi {
  registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
  updateContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
  getRegisteredContentScripts(): Promise<Array<{ id: string; excludeMatches?: string[] }>>;
}

function scripting(): ScriptingApi {
  return (browser as unknown as { scripting: ScriptingApi }).scripting;
}

/** WXT registration:'runtime' 的 hook 产物路径（构建输出 content-scripts/hook.js）。
 *  动态注册不进 manifest，getManifest 取不到，写死相对路径（已核对构建产物）。 */
export const HOOK_REGISTRATION = {
  id: HOOK_REGISTRATION_ID,
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: true,
  // scripting 的 RegisteredContentScript 默认不跨会话持久（与 userScripts 相反），
  // 必须显式 true，否则浏览器重启后 hook 不再注册。
  persistAcrossSessions: true,
  js: [{ file: 'content-scripts/hook.js' }],
} as const satisfies Omit<RegisteredContentScript, 'excludeMatches'>;

/** 名单变更 / SW 冷启动时对齐注册。幂等：一致则跳过。 */
export async function syncHookRegistration(): Promise<void> {
  const excludeMatches = await getHookExclusions();
  const desired: RegisteredContentScript = { ...HOOK_REGISTRATION, excludeMatches };

  let registered: Array<{ id: string; excludeMatches?: string[] }> = [];
  try {
    registered = await scripting().getRegisteredContentScripts();
  } catch {
    registered = []; // 极端漂移 → 按未注册处理，走 register 自愈
  }
  const existing = registered.find((r) => r.id === HOOK_REGISTRATION_ID);

  if (!existing) {
    await scripting().registerContentScripts([desired]);
    return;
  }
  const same = JSON.stringify(existing.excludeMatches ?? []) === JSON.stringify(excludeMatches);
  if (!same) {
    await scripting().updateContentScripts([desired]);
  }
}
