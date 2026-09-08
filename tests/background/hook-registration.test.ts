// tests/background/hook-registration.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { saveHookExclusions } from '../../background/hook-exclusions';
import {
  HOOK_REGISTRATION_ID,
  HOOK_REGISTRATION,
  syncHookRegistration,
} from '../../background/hook-registration';

describe('hook-registration', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    // fakeBrowser 的 scripting 注册族是 notMockedFunction（调用即抛 MockNotImplementedError），
    // 不保留 excludeMatches/persistAcrossSessions 字段——按 Step1 情形二，始终自建最小注册表 mock。
    // 用「裸 async 函数」而非 vi.fn：后续用例的 vi.spyOn 才能拿到 0 起点的全新计数
    //（spyOn 包裹已是 mock 的函数会继承其历史调用数，导致「跳过」断言误判）。
    const registry: Array<Record<string, unknown>> = [];
    fakeBrowser.scripting.registerContentScripts = (async (scripts: Array<Record<string, unknown>>) => { registry.push(...scripts); }) as never;
    fakeBrowser.scripting.getRegisteredContentScripts = (async () => [...registry]) as never;
    fakeBrowser.scripting.updateContentScripts = (async (scripts: Array<Record<string, unknown>>) => {
      for (const s of scripts) {
        const i = registry.findIndex((r) => r.id === s.id);
        if (i >= 0) registry[i] = { ...registry[i], ...s };
      }
    }) as never;
    fakeBrowser.scripting.unregisterContentScripts = (async (f?: { ids?: string[] }) => {
      if (!f?.ids) { registry.length = 0; return; }
      for (const id of f.ids) {
        const i = registry.findIndex((r) => r.id === id);
        if (i >= 0) registry.splice(i, 1);
      }
    }) as never;
  });

  it('未注册时 registerContentScripts，注册详情含 excludeMatches/persistAcrossSessions', async () => {
    await syncHookRegistration();
    const registered = await browser.scripting.getRegisteredContentScripts();
    const hook = registered.find((r) => r.id === HOOK_REGISTRATION_ID) as Record<string, unknown> | undefined;
    expect(hook).toBeDefined();
    expect(hook!.matches).toEqual(['<all_urls>']);
    expect(hook!.world).toBe('MAIN');
    expect(hook!.runAt).toBe('document_start');
    expect(hook!.allFrames).toBe(true);
    expect(hook!.persistAcrossSessions).toBe(true);
    expect(hook!.excludeMatches).toEqual([
      '*://*.zhipin.com/*', '*://*.lagou.com/*', '*://*.zhaopin.com/*', '*://*.51job.com/*',
    ]);
    expect(hook!.js).toEqual([{ file: 'content-scripts/hook.js' }]);
  });

  it('已注册且名单一致 → 跳过（不再调 register/update）', async () => {
    await syncHookRegistration();
    const spy = vi.spyOn(browser.scripting, 'registerContentScripts');
    const updateSpy = vi.spyOn(browser.scripting, 'updateContentScripts');
    await syncHookRegistration();
    expect(spy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('名单变更后 sync → updateContentScripts 更新 excludeMatches', async () => {
    await syncHookRegistration();
    await saveHookExclusions(['*://*.example.com/*']);
    await syncHookRegistration();
    const registered = await browser.scripting.getRegisteredContentScripts();
    const hook = registered.find((r) => r.id === HOOK_REGISTRATION_ID) as Record<string, unknown> | undefined;
    expect(hook!.excludeMatches).toEqual(['*://*.example.com/*']);
  });

  it('getRegisteredContentScripts 抛错 → 按未注册自愈 register', async () => {
    await syncHookRegistration();
    vi.spyOn(browser.scripting, 'getRegisteredContentScripts').mockRejectedValueOnce(new Error('drift'));
    await syncHookRegistration(); // 不抛错
    const registered = await browser.scripting.getRegisteredContentScripts();
    expect(registered.find((r) => r.id === HOOK_REGISTRATION_ID)).toBeDefined();
  });

  it('HOOK_REGISTRATION 常量形状（导出供测试与 UI 提示共用）', () => {
    expect(HOOK_REGISTRATION_ID).toBe('hook-observe');
    expect(HOOK_REGISTRATION.matches).toEqual(['<all_urls>']);
    expect(HOOK_REGISTRATION.js).toEqual([{ file: 'content-scripts/hook.js' }]);
  });
});
