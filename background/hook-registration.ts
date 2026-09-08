// background/hook-registration.ts
// MAIN world hook 的动态注册同步（spec 2026-09-08 §3.2）。
// hook.content.ts 用 registration: 'runtime'，manifest 不再声明，注册责任在本模块：
// matches=<all_urls> + excludeMatches=敏感站名单，diff 同步（同 scripts.ts 期望注册集自愈模式）。

import type { MessageRouter } from './router';
import { DEFAULT_HOOK_EXCLUSIONS, getHookExclusions, saveHookExclusions } from './hook-exclusions';

export const HOOK_REGISTRATION_ID = 'hook-observe';

// ---------- scripting.registerContentScripts 局部接口（Chrome 96+）----------
// 项目里 browser 走 WXT auto-import。scripting 的 RegisteredContentScript.js 是裸路径 string[]
//（例 ['content-scripts/hook.js']）——注意与 userScripts.register 的 `{ file }`/`{ code }` 对象形状
// 不同，别混。为避免与全局类型冲突，仿 scripts.ts 的 UserScriptsApi 局部接口模式自定形状。
interface RegisteredContentScript {
  id: string;
  matches: string[];
  excludeMatches?: string[];
  js: string[];
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
  // persistAcrossSessions 官方默认即 true；显式声明作防御，避免将来默认变更或平台差异导致
  // 浏览器重启后 hook 不再注册。
  persistAcrossSessions: true,
  js: ['content-scripts/hook.js'],
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

// ---------- 消息接线（spec 2026-09-08 §3.3）----------

/** 消息接线：GET / SAVE（save 全量覆盖 + 校验 + 注册同步）。 */
export function initHookRegistration(router: MessageRouter): void {
  router.on('HOOK_EXCLUSIONS_GET', async () => ({
    ok: true,
    data: { patterns: await getHookExclusions(), defaults: DEFAULT_HOOK_EXCLUSIONS },
  }));

  router.on('HOOK_EXCLUSIONS_SAVE', async (msg) => {
    const patterns = (msg as unknown as { patterns: string[] }).patterns;
    // 校验在 saveHookExclusions 内（非法整体拒绝抛错，router 统一转 { ok:false, error }）
    await saveHookExclusions(patterns);
    // 注册同步失败不回滚落库（下次 SW 冷启动自愈），返回 warnings 提示
    let warnings: string[] = [];
    try {
      await syncHookRegistration();
    } catch (e) {
      warnings = [`名单已保存，但 hook 注册同步失败（刷新扩展后自愈）：${e instanceof Error ? e.message : String(e)}`];
    }
    return { ok: true, data: { patterns: await getHookExclusions(), defaults: DEFAULT_HOOK_EXCLUSIONS, warnings } };
  });
}
