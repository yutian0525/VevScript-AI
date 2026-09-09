// tests/background/hook-exclusions.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import {
  DEFAULT_HOOK_EXCLUSIONS,
  getHookExclusions,
  saveHookExclusions,
  resetHookExclusions,
  validatePatterns,
} from '../../background/hook-exclusions';

describe('hook-exclusions', () => {
  beforeEach(() => fakeBrowser.reset());

  it('未存过时返回默认名单（招聘风控四站）', async () => {
    expect(await getHookExclusions()).toEqual(DEFAULT_HOOK_EXCLUSIONS);
  });

  it('saveHookExclusions 全量覆盖落库，get 回读一致', async () => {
    const next = ['*://*.example.com/*'];
    await saveHookExclusions(next);
    expect(await getHookExclusions()).toEqual(next);
    // 落库后不再兜底默认值
    expect(await getHookExclusions()).not.toEqual(DEFAULT_HOOK_EXCLUSIONS);
  });

  it('落库空名单后返回 []（关闭排除的合法态，?? 而非 || 兜底）', async () => {
    await saveHookExclusions([]);
    expect(await getHookExclusions()).toEqual([]);
  });

  it('saveHookExclusions 拒绝非法 pattern 并列出条目', async () => {
    expect(() => saveHookExclusions(['*://*.ok.com/*', 'not-a-pattern']))
      .toThrow('非法 match pattern：not-a-pattern');
    // 整体拒绝：合法条目也不落库
    expect(await getHookExclusions()).toEqual(DEFAULT_HOOK_EXCLUSIONS);
  });

  it('validatePatterns 返回非法条目（纯函数，UI 预检共用）', () => {
    expect(validatePatterns(['bad one', '*://*.zhipin.com/*'])).toEqual(['bad one']);
    expect(validatePatterns(['*://*.a.com/*', '<all_urls>'])).toEqual([]);
  });

  it('resetHookExclusions 删存储键回默认', async () => {
    await saveHookExclusions(['*://*.example.com/*']);
    const restored = await resetHookExclusions();
    expect(restored).toEqual(DEFAULT_HOOK_EXCLUSIONS);
    expect(await getHookExclusions()).toEqual(DEFAULT_HOOK_EXCLUSIONS);
    // 存储键确实被删（下次 get 走默认分支）
    expect(await storage.getItem('local:hook:exclusions')).toBeNull();
  });

  it('默认名单含招聘风控四站', () => {
    expect(DEFAULT_HOOK_EXCLUSIONS).toEqual([
      '*://*.zhipin.com/*',
      '*://*.lagou.com/*',
      '*://*.zhaopin.com/*',
      '*://*.51job.com/*',
    ]);
  });
});
