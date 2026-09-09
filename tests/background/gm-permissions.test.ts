// tests/background/gm-permissions.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import {
  getAlwaysAllow,
  setAlwaysAllow,
  removeScriptPermissions,
  listAllowedHosts,
  revokeHost,
  getLlmTier,
  setLlmTier,
} from '../../background/gm-permissions';

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

describe('listAllowedHosts / revokeHost', () => {
  beforeEach(() => fakeBrowser.reset());

  it('列出指定脚本的已授权 host，revokeHost 删除单条且幂等', async () => {
    await setAlwaysAllow('s1', 'a.com');
    await setAlwaysAllow('s1', 'b.com');
    await setAlwaysAllow('s2', 'c.com');
    expect((await listAllowedHosts('s1')).sort()).toEqual(['a.com', 'b.com']);
    await revokeHost('s1', 'a.com');
    expect(await listAllowedHosts('s1')).toEqual(['b.com']);
    await revokeHost('s1', 'not-exist.com'); // 幂等：不抛错
    expect(await listAllowedHosts('s1')).toEqual(['b.com']);
    expect(await listAllowedHosts('s3')).toEqual([]); // 无记录脚本 → 空数组
  });

  it('revoke 掉脚本最后一个 host 后，整个脚本条目从 storage 删除', async () => {
    await setAlwaysAllow('s1', 'a.com');
    await setAlwaysAllow('s2', 'b.com');
    await revokeHost('s1', 'a.com'); // s1 唯一的 host，删空
    const raw = await storage.getItem<Record<string, unknown>>('local:gm:permissions');
    expect(raw && 's1' in raw).toBe(false); // s1 的 key 已不存在（非留空对象）
    expect(raw && 's2' in raw).toBe(true); // 其他脚本不受影响
  });
});

describe('llm 权限档', () => {
  beforeEach(() => fakeBrowser.reset());

  it('缺省 ask；set/get 往返', async () => {
    expect(await getLlmTier('s1')).toBe('ask'); // 无记录 → 默认每次询问
    await setLlmTier('s1', 'allow');
    expect(await getLlmTier('s1')).toBe('allow');
    await setLlmTier('s1', 'deny');
    expect(await getLlmTier('s1')).toBe('deny');
    expect(await getLlmTier('s2')).toBe('ask'); // 其它脚本不受影响
  });

  it('与 cors 共存：setLlmTier 不清 alwaysAllow，反之亦然', async () => {
    await setAlwaysAllow('s1', 'a.com');
    await setLlmTier('s1', 'allow');
    expect(await getAlwaysAllow('s1', 'a.com')).toBe(true);
    expect(await getLlmTier('s1')).toBe('allow');
  });

  it('removeScriptPermissions 连 llm 档一起删', async () => {
    await setLlmTier('s1', 'deny');
    await removeScriptPermissions('s1');
    expect(await getLlmTier('s1')).toBe('ask');
  });
});
