// tests/shared/messages-phase4.test.ts
// 协议类型回归：8 个脚本 request 可构造 + 广播事件形状（spec §7）。
import { describe, it, expect, expectTypeOf } from 'vitest';
import type { ScriptsRequest, ScriptsRuntimeEvent, ScriptsListData, ScriptInput } from '../../shared/messages';

describe('Phase 4 脚本消息协议', () => {
  it('8 个 request 类型可构造且可赋值给 ScriptsRequest', () => {
    const reqs: ScriptsRequest[] = [
      { type: 'SCRIPTS_LIST' },
      { type: 'SCRIPTS_GET', id: 's1' },
      { type: 'SCRIPTS_CREATE', input: { name: 'n', code: 'c', matches: ['https://a.com/*'] } },
      { type: 'SCRIPTS_UPDATE', id: 's1', patch: { enabled: false } },
      { type: 'SCRIPTS_DELETE', id: 's1' },
      { type: 'SCRIPTS_SET_ENABLED', id: 's1', enabled: true },
      { type: 'SCRIPTS_IMPORT', source: '// ==UserScript==\n', filename: 'a.user.js' },
      { type: 'SCRIPTS_GET_RUNTIME' },
    ];
    expect(reqs).toHaveLength(8);
  });

  it('ScriptInput 可选字段缺省合法', () => {
    const input: ScriptInput = { name: 'n', code: 'c', matches: [] };
    expectTypeOf(input).toMatchTypeOf<ScriptInput>();
  });

  it('广播事件形状', () => {
    const e: ScriptsRuntimeEvent = { type: 'SCRIPTS_RUNTIME', payload: { tabId: 1, url: 'https://a.com/', scriptIds: ['s1'] } };
    expect(e.payload.scriptIds).toEqual(['s1']);
  });

  it('LIST 响应 data 含 engineAvailable', () => {
    const d: ScriptsListData = { scripts: [], engineAvailable: true };
    expect(d.engineAvailable).toBe(true);
  });
});
