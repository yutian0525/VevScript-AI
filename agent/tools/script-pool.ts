// agent/tools/script-pool.ts
// 脚本池六工具执行器（spec §8）。与 UI 共用 background/scripts 编排层——AI 改脚本 = 用户改脚本，行为零分叉。
// 全部豁免受限页预检（registry 在 RESTRICTED 检查之前分发）：不碰页面内容，纯 storage/注册操作。

import type { ToolResult } from '../../shared/types';
import type { ScriptInput, ScriptPatch } from '../../shared/messages';
import { getScript, listScripts, toSummary } from '../../storage/scripts';
import {
  handleCreate, handleDelete, handleSetEnabled, handleUpdate,
} from '../../background/scripts';

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function doListScripts(args: { enabled?: boolean; urlContains?: string }): Promise<ToolResult> {
  try {
    let scripts = (await listScripts()).map(toSummary);
    if (args.enabled !== undefined) scripts = scripts.filter((s) => s.enabled === args.enabled);
    if (args.urlContains) {
      const needle = args.urlContains.toLowerCase();
      scripts = scripts.filter((s) => s.matches.some((m) => m.toLowerCase().includes(needle)));
    }
    return { ok: true, data: { scripts } };
  } catch (e) {
    return { ok: false, error: `list_scripts 失败：${err(e)}` };
  }
}

export async function doGetScript(args: { id: string }): Promise<ToolResult> {
  try {
    const script = await getScript(args.id);
    if (!script) return { ok: false, error: `脚本不存在：${args.id}` };
    return { ok: true, data: { script } };
  } catch (e) {
    return { ok: false, error: `get_script 失败：${err(e)}` };
  }
}

export async function doCreateScript(args: ScriptInput): Promise<ToolResult> {
  try {
    // matches 必填非空是工具层约束（spec §8）；编排层允许空 matches（导入场景）
    if (!Array.isArray(args.matches) || args.matches.length === 0) {
      return { ok: false, error: 'create_script 需要至少一条 matches 规则（脚本要有明确作用域）' };
    }
    const { script, warnings } = await handleCreate({ ...args, source: 'agent' });
    return { ok: true, data: { script, warnings } };
  } catch (e) {
    return { ok: false, error: `create_script 失败：${err(e)}` };
  }
}

export async function doUpdateScript(args: { id: string; patch: ScriptPatch }): Promise<ToolResult> {
  try {
    return { ok: true, data: { script: await handleUpdate(args.id, args.patch) } };
  } catch (e) {
    return { ok: false, error: `update_script 失败：${err(e)}` };
  }
}

export async function doDeleteScript(args: { id: string }): Promise<ToolResult> {
  try {
    await handleDelete(args.id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `delete_script 失败：${err(e)}` };
  }
}

export async function doToggleScript(args: { id: string; enabled: boolean }): Promise<ToolResult> {
  try {
    return { ok: true, data: { script: await handleSetEnabled(args.id, args.enabled) } };
  } catch (e) {
    return { ok: false, error: `toggle_script 失败：${err(e)}` };
  }
}
