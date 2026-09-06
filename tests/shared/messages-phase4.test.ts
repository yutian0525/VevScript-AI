// tests/shared/messages-phase4.test.ts
// 协议类型回归：8 个脚本 request 可构造 + 广播事件形状（spec §7 + 2026-09-02 修订）。
import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  ScriptsRequest, ScriptsRuntimeEvent, ScriptsListData,
  ScriptInput, ScriptPatch, ScriptGetData,
} from '../../shared/messages';

describe('Phase 4 脚本消息协议', () => {
  it('8 个 request 类型可构造且可赋值给 ScriptsRequest（含修订后的 GET 区间/IMPORT text）', () => {
    const reqs: ScriptsRequest[] = [
      { type: 'SCRIPTS_LIST' },
      { type: 'SCRIPTS_GET', id: 's1' },
      { type: 'SCRIPTS_GET', id: 's1', offset: 10, limit: 20 },
      { type: 'SCRIPTS_CREATE', input: { text: '// ==UserScript==\n' } },
      { type: 'SCRIPTS_UPDATE', id: 's1', patch: { enabled: false } },
      { type: 'SCRIPTS_UPDATE', id: 's1', patch: { text: '// ==UserScript==\n' } },
      { type: 'SCRIPTS_UPDATE', id: 's1', patch: { edit: { startLine: 1, endLine: 2, text: 'x' } } },
      { type: 'SCRIPTS_DELETE', id: 's1' },
      { type: 'SCRIPTS_SET_ENABLED', id: 's1', enabled: true },
      { type: 'SCRIPTS_IMPORT', text: '// ==UserScript==\n', filename: 'a.user.js' },
      { type: 'SCRIPTS_GET_RUNTIME' },
    ];
    expect(reqs.length).toBe(11);
  });

  it('ScriptInput：text 必填，其余可选', () => {
    const input: ScriptInput = { text: '// x\n' };
    expectTypeOf(input).toMatchTypeOf<ScriptInput>();
  });

  it('ScriptPatch：text/enabled/edit 均可选，edit 为行区间', () => {
    const patch: ScriptPatch = { edit: { startLine: 2, endLine: 3, text: 'y' } };
    expectTypeOf(patch).toMatchTypeOf<ScriptPatch>();
  });

  it('ScriptGetData 形状', () => {
    const d: ScriptGetData = {
      script: {
        id: 's1', text: '', name: 'n', enabled: true, matches: [], code: '',
        runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 0, updatedAt: 0,
      },
      totalLines: 1, startLine: 1, endLine: 1,
    };
    expect(d.totalLines).toBe(1);
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
