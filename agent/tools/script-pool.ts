// agent/tools/script-pool.ts
// 脚本池六工具执行器（spec §8 + 2026-09-02 修订：文本为源）。与 UI 共用 background/scripts 编排层——AI 改脚本 = 用户改脚本，行为零分叉。
// 全部豁免受限页预检（registry 在 RESTRICTED 检查之前分发）：不碰页面内容，纯 storage/注册操作。

import type { ScriptUpdateState, ToolResult, UserScript } from '../../shared/types';
import type { ScriptPatch } from '../../shared/messages';
import { parseUserScript } from '../../shared/userscript-meta';
import { checkBalance } from '../../shared/js-balance';
import { listScripts, toSummary } from '../../storage/scripts';
import { gmErrorCounts } from '../../background/gm-api';
import {
  handleCreate, handleDelete, handleGet, handleSetEnabled, handleUpdate,
} from '../../background/scripts';
import { handleImportUrl, handleApplyUpdate, readUpdateStates } from '../../background/scripts-update';

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

// create_script 的 source 长度硬闸（spec §4.2）：阈值宽松——200 行以下仍可一次写完，
// 不白多一次往返。只拦 AI 逐 token 吐出的 source；url 导入/UI 导入/patch.text 不受限
// （那些不是模型在生成），总量另由 storage 的 MAX_TEXT_LENGTH（280KB）管。
export const MAX_CREATE_LINES = 200;
export const MAX_CREATE_CHARS = 8192;

function createGateError(text: string): string | undefined {
  const lines = text.split('\n').length;
  if (lines <= MAX_CREATE_LINES && text.length <= MAX_CREATE_CHARS) return undefined;
  return `create_script 的 source 过长（${lines} 行 / ${text.length} 字符，上限 ${MAX_CREATE_LINES} 行 / ${MAX_CREATE_CHARS} 字符）。`
    + '长脚本请分步：先只提交元数据头 + 未闭合的 IIFE 骨架（如 `(function () {` 结尾，不写 `})();`），'
    + '再用 update_script 的 patch.append 分次追加代码体，最后一段带上 `})();` 闭合。';
}

/** 附加给摘要的更新提示（只读后台检查缓存；无缓存则字段缺省）。 */
function toUpdateHint(st: ScriptUpdateState | undefined) {
  if (!st) return undefined;
  return {
    hasUpdate: st.status === 'available',
    status: st.status,
    remoteVersion: st.remoteVersion || undefined,
    checkedAt: st.checkedAt,
    message: st.message,
  };
}

/** 写操作的精简返回（spec §3.4）：不回灌 text/code，只给模型下一步决策需要的元信息 + 配平状态。
 *  balance 只报告不阻断——分步 append 的中间态必然 unclosed（骨架刻意不闭合 IIFE）。 */
function toWriteResult(script: UserScript, warnings: string[]) {
  const bal = checkBalance(script.code);
  return {
    id: script.id,
    name: script.name,
    lines: script.text.split('\n').length,
    bytes: script.text.length,
    matches: script.matches,
    enabled: script.enabled,
    runAt: script.runAt,
    world: script.world,
    warnings,
    balance: bal.ok ? ('ok' as const) : ('unclosed' as const),
    ...(bal.ok ? {} : { balanceDetail: bal.detail }),
  };
}

export async function doListScripts(args: { enabled?: boolean; urlContains?: string }): Promise<ToolResult> {
  try {
    const updates = await readUpdateStates();
    // update 字段来自后台启动检查的缓存（只读、不触发网络检查）：available 即有可用更新；
    // 缺省 = 该脚本从未被检查过（无更新源，或后台尚未跑过检查）。要更新用 update_script + patch.applyUpdate。
    let scripts = (await listScripts()).map((s) => ({
      ...toSummary(s, gmErrorCounts()[s.id] ?? 0),
      update: toUpdateHint(updates[s.id]),
    }));
    // != null 而非 !== undefined：模型 JSON 透传的 null 会被后者当成「要过滤」，静默返回空列表
    if (args.enabled != null) scripts = scripts.filter((s) => s.enabled === args.enabled);
    if (args.urlContains) {
      const needle = args.urlContains.toLowerCase();
      scripts = scripts.filter((s) => s.matches.some((m) => m.toLowerCase().includes(needle)));
    }
    return { ok: true, data: { scripts } };
  } catch (e) {
    return { ok: false, error: `list_scripts 失败：${err(e)}` };
  }
}

/** 模型不传区间时的默认返回行数（spec §4.4）：避免整份长脚本灌进上下文。 */
export const DEFAULT_GET_LIMIT = 200;

/** 给每行加右对齐行号前缀（`%4d| `），供模型做 edit 时不必自己数行。 */
export function annotateLines(text: string, startLine: number): string {
  return text
    .split('\n')
    .map((l, i) => `${String(startLine + i).padStart(4, ' ')}| ${l}`)
    .join('\n');
}

export async function doGetScript(args: { id: string; offset?: number; limit?: number }): Promise<ToolResult> {
  try {
    // 模型不传区间 → 工具层自己按 DEFAULT_GET_LIMIT 请求（编排层语义不变，仍支持全文）
    const explicit = args.offset !== undefined || args.limit !== undefined;
    const offset = args.offset ?? 1;
    const limit = args.limit ?? (explicit ? undefined : DEFAULT_GET_LIMIT);
    const data = await handleGet(args.id, offset, limit);
    // 行号是标注不是内容：schema description 里说明写回时不要带上前缀
    const script = { ...data.script, text: annotateLines(data.script.text, data.startLine) };
    const notice = data.endLine < data.totalLines
      ? `已返回第 ${data.startLine}-${data.endLine} 行（共 ${data.totalLines} 行）。继续读用 offset=${data.endLine + 1}，定位特定代码用 grep_script。`
      : undefined;
    return { ok: true, data: { ...data, script, ...(notice ? { notice } : {}) } };
  } catch (e) {
    return { ok: false, error: `get_script 失败：${err(e)}` };
  }
}

export async function doCreateScript(args: { source?: string; text?: string; url?: string; enabled?: boolean }): Promise<ToolResult> {
  try {
    // url 分支：从直链下载安装（fetch → 注入 @updateURL → 解析导入），来源记为 agent。与 source 二选一。
    if (typeof args.url === 'string' && args.url.trim()) {
      const { script, warnings } = await handleImportUrl(args.url.trim(), 'agent');
      return { ok: true, data: toWriteResult(script, warnings) };
    }
    // 工具参数名是 source（spec §8 冻结），编排层字段名是 text——此处做名称映射；text 别名留给内部调用
    const text = typeof args.source === 'string' ? args.source : args.text;
    // matches 非空是工具层约束（spec §8：解析头部后有匹配规则才创建）；编排层允许空 matches（导入场景）
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: 'create_script 需要 source（完整 .user.js 文本）或 url（.user.js 直链）二选一' };
    }
    // 长度硬闸在 matches 校验之前：长度错误比「缺 @match」更可操作——模型该先改写作策略（分步），而不是先补头部字段
    const gate = createGateError(text);
    if (gate) return { ok: false, error: gate };
    if (parseUserScript(text).fields.matches.length === 0) {
      return { ok: false, error: 'create_script 解析后无匹配规则：请在头部添加 @match（pattern 形式的 @include 也计入）' };
    }
    const { script, warnings } = await handleCreate({ text, enabled: args.enabled, source: 'agent' });
    return { ok: true, data: toWriteResult(script, warnings) };
  } catch (e) {
    return { ok: false, error: `create_script 失败：${err(e)}` };
  }
}

export async function doUpdateScript(args: { id: string; patch: ScriptPatch }): Promise<ToolResult> {
  try {
    // applyUpdate 分支：从更新源拉远端最新文本覆盖（与 text/edit 互斥，优先生效）
    if (args.patch?.applyUpdate) {
      return { ok: true, data: toWriteResult(await handleApplyUpdate(args.id), []) };
    }
    return { ok: true, data: toWriteResult(await handleUpdate(args.id, args.patch), []) };
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
    // 启停无需回全文，同样走精简返回
    return { ok: true, data: toWriteResult(await handleSetEnabled(args.id, args.enabled), []) };
  } catch (e) {
    return { ok: false, error: `toggle_script 失败：${err(e)}` };
  }
}
