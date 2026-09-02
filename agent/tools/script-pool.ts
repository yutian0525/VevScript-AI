// agent/tools/script-pool.ts
// 脚本池六工具执行器（spec §8 + 2026-09-02 修订：文本为源）。与 UI 共用 background/scripts 编排层——AI 改脚本 = 用户改脚本，行为零分叉。
// 全部豁免受限页预检（registry 在 RESTRICTED 检查之前分发）：不碰页面内容，纯 storage/注册操作。

import type { ToolResult } from '../../shared/types';
import type { ScriptPatch } from '../../shared/messages';
import { parseUserScript } from '../../shared/userscript-meta';
import { listScripts, toSummary } from '../../storage/scripts';
import {
  handleCreate, handleDelete, handleGet, handleSetEnabled, handleUpdate,
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

export async function doGetScript(args: { id: string; offset?: number; limit?: number }): Promise<ToolResult> {
  try {
    // data: { script, totalLines, startLine, endLine }；传区间时 script.text 为行切片（spec §8 修订）
    return { ok: true, data: await handleGet(args.id, args.offset, args.limit) };
  } catch (e) {
    return { ok: false, error: `get_script 失败：${err(e)}` };
  }
}

export async function doCreateScript(args: { source?: string; text?: string; enabled?: boolean }): Promise<ToolResult> {
  try {
    // 工具参数名是 source（spec §8 冻结），编排层字段名是 text——此处做名称映射；text 别名留给内部调用
    const text = typeof args.source === 'string' ? args.source : args.text;
    // matches 非空是工具层约束（spec §8：解析头部后有匹配规则才创建）；编排层允许空 matches（导入场景）
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: 'create_script 需要 source：完整的 .user.js 文本（含 ==UserScript== 元数据头）' };
    }
    if (parseUserScript(text).fields.matches.length === 0) {
      return { ok: false, error: 'create_script 解析后无匹配规则：请在头部添加 @match（pattern 形式的 @include 也计入）' };
    }
    const { script, warnings } = await handleCreate({ text, enabled: args.enabled, source: 'agent' });
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
