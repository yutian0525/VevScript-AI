import { describe, it, expect } from 'vitest';
import { CALL } from '../../components/scriptdebug/ScriptDebugPage';
import { GM_API_REGISTRY } from '../../shared/gm-apis';

describe('CALL 表完备性', () => {
  it('CALL 键集 = GM_API_REGISTRY 键集（防新增 GM API 漏登记导致白屏）', () => {
    expect(new Set(Object.keys(CALL))).toEqual(new Set(Object.keys(GM_API_REGISTRY)));
  });

  it('bridge/sw 类必带点形式短名，page 类不带', () => {
    for (const [name, call] of Object.entries(CALL)) {
      if (call.kind === 'page') {
        expect(call.short, `${name} 是页面内 API，不应有 short`).toBeUndefined();
      } else {
        expect(call.short, `${name} 可直调，必须带点形式短名`).toBeDefined();
      }
    }
  });
});
