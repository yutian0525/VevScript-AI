// tests/background/gm-permissions.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getAlwaysAllow, setAlwaysAllow, removeScriptPermissions } from '../../background/gm-permissions';

describe('gm-permissions', () => {
  beforeEach(() => fakeBrowser.reset());

  it('setAlwaysAllow 落库；getAlwaysAllow 命中/未命中', async () => {
    expect(await getAlwaysAllow('s1', 'api.a.com')).toBe(false);
    await setAlwaysAllow('s1', 'api.a.com');
    expect(await getAlwaysAllow('s1', 'api.a.com')).toBe(true);
    expect(await getAlwaysAllow('s1', 'other.com')).toBe(false);
    expect(await getAlwaysAllow('s2', 'api.a.com')).toBe(false);
  });

  it('removeScriptPermissions 清整个脚本的授权（删除脚本时调用）', async () => {
    await setAlwaysAllow('s1', 'a.com');
    await setAlwaysAllow('s1', 'b.com');
    await setAlwaysAllow('s2', 'a.com');
    await removeScriptPermissions('s1');
    expect(await getAlwaysAllow('s1', 'a.com')).toBe(false);
    expect(await getAlwaysAllow('s2', 'a.com')).toBe(true);
  });
});
