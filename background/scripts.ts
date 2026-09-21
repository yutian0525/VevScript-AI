// background/scripts.ts
// 脚本池编排层（spec §6）：CRUD（落库 + userScripts 注册同步原子完成）+ 运行态跟踪与广播。
// UI（sidepanel）与 AI 工具（agent/tools/script-pool.ts）都走本模块导出的 handler——单一数据源。
// confirmGate 拦截位：下阶段确认门控在本文件各写 handler 入口处统一拦截（pendingOps + 批准卡）。
// 文本补丁原语（appendText/replaceText）已抽到 shared/text-patch.ts（脚本池与技能池共用）。

import type { MessageRouter } from './router';
import type { ScriptGetData, ScriptInput, ScriptPatch, ScriptsRuntimeEntry, ScriptsChangedEvent, ScriptsChangedReason } from '../shared/messages';
import type { ScriptRunAt, ScriptSource, ScriptWorld, UserScript } from '../shared/types';
import { deleteScript, getScript, listScripts, saveScript, toSummary, MAX_CODE_LENGTH, MAX_TEXT_LENGTH } from '../storage/scripts';
import { isValidMatchPattern, matchUrl } from '../shared/match-pattern';
import { parseUserScript } from '../shared/userscript-meta';
import { gmErrorCounts, readValuesForSnapshot, cleanupScriptState, __resetLlmSessionFor } from './gm-api'; // Task 7 提供：Record<scriptId, number>
import { buildWrappedCode } from '../shared/gm-wrapper';
import { appendText, replaceText } from '../shared/text-patch';
import { getBridgeToken } from './gm-token';
import { prefetchResources, getResourceBundle } from './gm-resources';
import { listAllowedHosts, revokeHost, removeScriptPermissions, getLlmTier, setLlmTier } from './gm-permissions';
import { handleImportUrl, checkScriptUpdate, handleApplyUpdate, clearUpdateState } from './scripts-update';

export const ENGINE_UNAVAILABLE_MSG = '脚本注入引擎不可用：请在 chrome://extensions 开启开发者模式或升级 Chrome 120+';

// ---------- 运行态跟踪（spec §6.2）----------
// 「运行中」= URL 匹配且启用的脚本（预期注入），非「实际执行成功」回执——脚本抛错仍显示运行中。
// SW 内存 map，重启丢失、下次导航/查询自重建（best-effort，与 observe-store 同哲学）。

const runtimeMap = new Map<number, ScriptsRuntimeEntry>();

export function computeRuntimeScriptIds(url: string, scripts: UserScript[]): string[] {
  if (!url) return [];
  return scripts.filter((s) => s.enabled && matchUrl(s.matches, url)).map((s) => s.id);
}

function sameEntry(a: ScriptsRuntimeEntry | undefined, b: ScriptsRuntimeEntry): boolean {
  return a != null && a.url === b.url && a.scriptIds.length === b.scriptIds.length
    && a.scriptIds.every((id, i) => id === b.scriptIds[i]);
}

function broadcastRuntime(entry: ScriptsRuntimeEntry): void {
  // 无接收方（sidepanel 未开）时 sendMessage 会 reject——fire-and-forget，吞掉即可
  void browser.runtime.sendMessage({ type: 'SCRIPTS_RUNTIME', payload: entry }).catch(() => {});
}

/** 脚本清单写变更广播（增/改/启停/删/导入）：驱动侧栏 refresh、详情页刷新/删除、popup 重载。
 *  与 broadcastRuntime 互补——运行集不变的纯改码也要发，故独立于 recomputeTab 的去重闸。 */
function broadcastScriptsChanged(reason: ScriptsChangedReason, ids?: string[]): void {
  const msg: ScriptsChangedEvent = { type: 'SCRIPTS_CHANGED', reason, ...(ids ? { ids } : {}) };
  void browser.runtime.sendMessage(msg).catch(() => {});
}

export async function recomputeTab(tabId: number, url: string): Promise<void> {
  const all = await listScripts();
  const entry: ScriptsRuntimeEntry = { tabId, url, scriptIds: computeRuntimeScriptIds(url, all) };
  if (sameEntry(runtimeMap.get(tabId), entry)) return;
  runtimeMap.set(tabId, entry);
  broadcastRuntime(entry);
}

export async function recomputeAllTabs(): Promise<void> {
  const tabs = await browser.tabs.query({});
  await Promise.all(
    tabs
      .filter((t) => t.id != null && t.url)
      .map((t) => recomputeTab(t.id!, t.url!)),
  );
}

export function dropTab(tabId: number): void {
  runtimeMap.delete(tabId);
}

export function getRuntimeSnapshot(): ScriptsRuntimeEntry[] {
  return [...runtimeMap.values()];
}

// ---------- userScripts API 薄封装（Chrome 120+；Firefox 形状不同，本阶段 Chrome-only）----------

interface RegisterUserScript {
  id: string;
  matches: string[];
  js: Array<{ code: string }>;
  runAt: ScriptRunAt;
  world: ScriptWorld;
}

interface UserScriptsApi {
  register(scripts: RegisterUserScript[]): Promise<void>;
  update(scripts: RegisterUserScript[]): Promise<void>;
  // Chrome 真实签名：unregister(filter?: { ids?: string[] })——传裸数组会被参数校验拒绝
  // （"No matching signature"），导致注销失败、陈旧脚本永不注销、错误冒泡到禁用/删除/导入 UI。
  unregister(filter?: { ids?: string[] }): Promise<void>;
  getScripts(): Promise<RegisterUserScript[]>;
  configureWorld?(properties: { csp?: string; messaging?: boolean }): Promise<void>;
}

function userScripts(): UserScriptsApi | undefined {
  return (browser as unknown as { userScripts?: UserScriptsApi }).userScripts;
}

export function engineAvailable(): boolean {
  return userScripts() != null;
}

async function requireEngine(): Promise<UserScriptsApi> {
  const api = userScripts();
  if (!api) throw new Error(ENGINE_UNAVAILABLE_MSG);
  return api;
}

// ---------- 校验（spec §6.1：非法 pattern 拒绝并列出条目；编排层允许空 matches）----------

const RUN_ATS: ScriptRunAt[] = ['document_start', 'document_end', 'document_idle'];
const WORLDS: ScriptWorld[] = ['USER_SCRIPT', 'MAIN'];

export function validateScriptFields(fields: {
  name?: string; code?: string; matches?: string[]; runAt?: unknown; world?: unknown;
}): string[] {
  const errors: string[] = [];
  if (fields.name !== undefined && !fields.name.trim()) errors.push('name 不能为空');
  if (fields.code !== undefined) {
    if (!fields.code.trim()) errors.push('code 不能为空');
    else if (fields.code.length > MAX_CODE_LENGTH) errors.push(`code 超过上限（${MAX_CODE_LENGTH} 字符）`);
  }
  if (fields.matches !== undefined) {
    const bad = fields.matches.filter((p) => !isValidMatchPattern(p));
    if (bad.length > 0) errors.push(`非法 match pattern：${bad.join('、')}`);
  }
  if (fields.runAt !== undefined && !RUN_ATS.includes(fields.runAt as ScriptRunAt)) {
    errors.push(`非法 runAt：${String(fields.runAt)}`);
  }
  if (fields.world !== undefined && !WORLDS.includes(fields.world as ScriptWorld)) {
    errors.push(`非法 world：${String(fields.world)}`);
  }
  return errors;
}

// ---------- 注册同步（spec §6.1：期望注册集 vs getScripts diff）----------

/** 扩展版本号（wrapper GM_info 用）；SW 下取 manifest，测试环境 getManifest 未实现抛错 → 兜底 0.0.0。 */
function extensionVersion(): string {
  try {
    return browser.runtime.getManifest().version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 期望注册详情：带 grant 或 @require 的脚本走 wrapper（buildWrappedCode），否则裸 code（零开销）。 */
async function toRegisterDetailsAsync(s: UserScript): Promise<RegisterUserScript> {
  // 注意：chrome.userScripts.RegisteredUserScript 没有 persistAcrossSessions 字段（那是
  // chrome.scripting.RegisteredContentScript 的属性）——带上它会被 Chrome 参数校验直接拒绝整个
  // register() 调用（"Unexpected property: 'persistAcrossSessions'"），脚本因此永不注册。
  // userScripts 本身默认即跨会话持久，无需也不能显式声明。
  const base = { id: s.id, matches: s.matches, runAt: s.runAt, world: s.world };
  const realGrants = (s.meta?.grants ?? []).filter((g) => g !== 'none');
  const hasRequires = (s.meta?.requires?.length ?? 0) > 0;
  if (realGrants.length === 0 && !hasRequires) {
    return { ...base, js: [{ code: s.code }] };
  }
  const [token, values, bundle] = await Promise.all([
    getBridgeToken(s.id),
    readValuesForSnapshot(s.id),
    getResourceBundle(s),
  ]);
  const code = buildWrappedCode(s, {
    token, values, resources: bundle.resources, resourceUrls: bundle.resourceUrls,
    requireCodes: bundle.requireCodes, extensionVersion: extensionVersion(),
  });
  return { ...base, js: [{ code }] };
}

/** drift 检测：比对已注册与构建后的注册详情（js[0].code 已是最终 wrapped/bare 码）。 */
function sameRegistration(r: RegisterUserScript, b: RegisterUserScript): boolean {
  return r.runAt === b.runAt && r.world === b.world
    && JSON.stringify(r.matches) === JSON.stringify(b.matches)
    && r.js?.[0]?.code === b.js?.[0]?.code;
}

// USER_SCRIPT world 默认 CSP = ISOLATED world CSP（script-src 'self'）——禁 eval，wrapper 的
// new Function（语法预探测 + 执行体构造）会被 CSP 拦截（"Evaluating a string as JavaScript
// violates ... 'unsafe-eval' is not an allowed source"），脚本第一行就失败。放行 unsafe-eval。
const WORLD_CSP = "script-src 'self' 'unsafe-eval'";

export async function configureWorldCsp(api: UserScriptsApi): Promise<void> {
  if (!api.configureWorld) return; // 旧 Chrome 无此 API——脚本若不用 eval 类构造照常可跑
  await api.configureWorld({ csp: WORLD_CSP });
}

export async function syncRegistrations(): Promise<void> {
  const api = await requireEngine();
  await configureWorldCsp(api);
  const all = await listScripts();
  // 空 matches 的脚本永不注册（无匹配规则 = 不运行，spec §5.1）
  const desired = all.filter((s) => s.enabled && s.matches.length > 0);
  const desiredIds = new Set(desired.map((s) => s.id));

  let registered: RegisterUserScript[] = [];
  try {
    registered = await api.getScripts();
  } catch {
    registered = []; // getScripts 漂移异常时按空处理 → 全量重注册自愈
  }
  const registeredMap = new Map(registered.map((r) => [r.id, r]));

  // 先构建全部期望注册（含 wrapper code）——drift 检测比对构建后的码，避免包裹脚本被误判 drift
  const built = await Promise.all(desired.map(toRegisterDetailsAsync));

  const missing = built.filter((b) => !registeredMap.has(b.id));
  if (missing.length > 0) await api.register(missing);

  const stale = registered.filter((r) => !desiredIds.has(r.id)).map((r) => r.id);
  if (stale.length > 0) await api.unregister({ ids: stale });

  const drifted = built.filter((b) => {
    const r = registeredMap.get(b.id);
    return r != null && !sameRegistration(r, b);
  });
  for (const b of drifted) {
    try {
      await api.update([b]);
    } catch {
      // update 打在未注册 id 上（极端漂移）→ 降级为先注销再注册
      await api.unregister({ ids: [b.id] });
      await api.register([b]);
    }
  }
}

/** 写库后的注册同步：引擎可用 → sync；不可用/失败 → 不抛错，返回给调用方展示的 warnings。 */
async function syncBestEffort(): Promise<string[]> {
  if (!engineAvailable()) return [`${ENGINE_UNAVAILABLE_MSG}（脚本已保存，但未注册运行）`];
  try {
    await syncRegistrations();
    return [];
  } catch (e) {
    return [`已保存但注册失败：${e instanceof Error ? e.message : String(e)}`];
  }
}

function newId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- 文本为源（修订 2026-09-02）：行区间原语 + 解析构建 ----------

/** 行区间替换（1-based 含端点）：非法区间/越界 throw；返回替换后的完整文本。 */
export function spliceLines(text: string, startLine: number, endLine: number, replacement: string): string {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error(`非法行区间：${startLine}-${endLine}（需 1 ≤ startLine ≤ endLine）`);
  }
  const lines = text.split('\n');
  if (endLine > lines.length) {
    throw new Error(`行区间越界：endLine=${endLine} 超过总行数 ${lines.length}`);
  }
  return [...lines.slice(0, startLine - 1), replacement, ...lines.slice(endLine)].join('\n');
}

/** 文本 → 校验通过的全量 UserScript：投影字段全部由 parseUserScript 生成（spec §6.1 修订）。 */
function buildFromText(args: {
  text: string; id: string; enabled: boolean; source: ScriptSource; createdAt: number; fallbackName?: string;
}): { script: UserScript; warnings: string[] } {
  if (args.text.length > MAX_TEXT_LENGTH) throw new Error(`脚本文本超过上限（${MAX_TEXT_LENGTH} 字符）`);
  const parsed = parseUserScript(args.text, args.fallbackName);
  const errors = validateScriptFields({
    name: parsed.fields.name, code: parsed.fields.code, matches: parsed.fields.matches,
    runAt: parsed.fields.runAt, world: parsed.fields.world,
  });
  if (errors.length > 0) throw new Error(errors.join('；'));
  const script: UserScript = {
    id: args.id,
    text: args.text,
    name: parsed.fields.name,
    enabled: args.enabled,
    matches: parsed.fields.matches,
    code: parsed.fields.code,
    runAt: parsed.fields.runAt,
    world: parsed.fields.world,
    source: args.source,
    meta: Object.keys(parsed.fields.meta).length > 0 ? parsed.fields.meta : undefined,
    createdAt: args.createdAt,
    updatedAt: Date.now(),
  };
  return { script, warnings: parsed.warnings };
}

// ---------- CRUD 编排（UI 与 AI 工具共用；confirmGate 拦截位见文件头注释）----------

export async function handleCreate(input: ScriptInput): Promise<{ script: UserScript; warnings: string[] }> {
  if (typeof input?.text !== 'string' || !input.text.trim()) {
    throw new Error('text 必填：完整的 .user.js 文本（含 ==UserScript== 头）');
  }
  const { script, warnings } = buildFromText({
    text: input.text, id: newId(), enabled: input.enabled ?? true,
    source: input.source ?? 'user', createdAt: Date.now(),
  });
  await saveScript(script);
  const resWarnings = await prefetchResources(script);
  const syncWarnings = await syncBestEffort();
  await recomputeAllTabs().catch(() => {});
  broadcastScriptsChanged('create', [script.id]);
  return { script, warnings: [...warnings, ...resWarnings, ...syncWarnings] };
}

/** 文本改动分支：四支互斥（同传两支报错，不静默按优先级取一支——静默取舍会让模型
 *  误以为两处改动都生效）。applyUpdate 由调用方在此之前拦下，不参与本组判定。 */
const TEXT_BRANCHES = ['text', 'edit', 'append', 'replace'] as const;

export async function handleUpdate(id: string, patch: ScriptPatch): Promise<UserScript> {
  await requireEngine(); // spec §6.1：改注册类操作引擎不可用直接报固定文案
  const existing = await getScript(id);
  if (!existing) throw new Error(`脚本不存在：${id}`);

  // != null 而非 !== undefined：挡掉模型 JSON 透传的 null 分支（如 { append: null }）
  const branches = TEXT_BRANCHES.filter((k) => patch[k] != null);
  if (branches.length > 1) {
    throw new Error(`patch 只能传一个文本改动分支，收到 ${branches.length} 个：${branches.join('、')}`);
  }
  if (branches.length === 0 && patch.enabled === undefined) {
    throw new Error('patch 至少包含 text / edit / append / replace / enabled 之一');
  }

  let next: UserScript;
  if (branches.length === 1) {
    // 文本路径：算出新原文后整体重解析（文本为源，投影字段全部重建）
    let text: string;
    switch (branches[0]) {
      case 'edit':
        text = spliceLines(existing.text, patch.edit!.startLine, patch.edit!.endLine, patch.edit!.text);
        break;
      case 'append':
        text = appendText(existing.text, patch.append!);
        break;
      case 'replace':
        text = replaceText(
          existing.text, patch.replace!.old, patch.replace!.new, patch.replace!.all ?? false,
          '请先用 get_script 或 grep_script 确认原文',
        );
        break;
      case 'text':
        if (!patch.text!.trim()) throw new Error('text 必填：完整的 .user.js 文本（含 ==UserScript== 头）');
        text = patch.text!;
        break;
      default:
        // TEXT_BRANCHES 已穷举四支，走到这里说明类型层被绕过——无穷举保护
        throw new Error(`未处理的文本分支：${String(branches[0])}`);
    }
    next = buildFromText({
      text, id: existing.id, enabled: patch.enabled ?? existing.enabled,
      source: existing.source, createdAt: existing.createdAt,
    }).script;
    await clearUpdateState(id).catch(() => {}); // spec §1.2 不变量：本地改动使旧检查结果过期
  } else {
    // 仅启停：不重解析
    next = { ...existing, enabled: patch.enabled as boolean, updatedAt: Date.now() };
  }

  await saveScript(next);
  const resWarnings = await prefetchResources(next);
  if (resWarnings.length > 0) console.warn('[scripts] 依赖预取:', ...resWarnings);
  await syncRegistrations();
  await recomputeAllTabs().catch(() => {});
  // 纯启停也报 update：接收方只需知道该脚本清单字段变了（enabled/name/matches 任一）
  broadcastScriptsChanged(branches.length === 0 ? 'enable' : 'update', [id]);
  return next;
}

/** 行区间读取（修订 2026-09-02）：offset/limit 缺省全文；1-based、越界钳制、limit 缺省读到末尾。 */
export async function handleGet(id: string, offset?: number, limit?: number): Promise<ScriptGetData> {
  const script = await getScript(id);
  if (!script) throw new Error(`脚本不存在：${id}`);
  const lines = script.text.split('\n');
  const totalLines = lines.length;
  if (offset === undefined && limit === undefined) {
    return { script, totalLines, startLine: 1, endLine: totalLines };
  }
  const rawStart = Math.trunc(offset ?? 1);
  const rawEnd = limit === undefined ? totalLines : rawStart + Math.max(1, Math.trunc(limit)) - 1;
  const startLine = Math.min(Math.max(1, rawStart), totalLines);
  const endLine = Math.min(Math.max(1, rawEnd), totalLines);
  const text = startLine > endLine ? '' : lines.slice(startLine - 1, endLine).join('\n');
  return { script: { ...script, text }, totalLines, startLine, endLine };
}

export async function handleDelete(id: string): Promise<void> {
  await requireEngine();
  await deleteScript(id);
  await clearUpdateState(id).catch(() => {}); // spec §1.2 不变量
  await cleanupScriptState(id);
  await removeScriptPermissions(id).catch(() => {});
  await syncRegistrations();
  await recomputeAllTabs().catch(() => {});
  broadcastScriptsChanged('delete', [id]);
}

export async function handleSetEnabled(id: string, enabled: boolean): Promise<UserScript> {
  await requireEngine();
  const existing = await getScript(id);
  if (!existing) throw new Error(`脚本不存在：${id}`);
  const next: UserScript = { ...existing, enabled, updatedAt: Date.now() };
  await saveScript(next);
  await syncRegistrations();
  await recomputeAllTabs().catch(() => {});
  broadcastScriptsChanged('enable', [id]);
  return next;
}

export async function handleImport(
  text: string,
  filename?: string,
  source: ScriptSource = 'import',
): Promise<{ script: UserScript; warnings: string[] }> {
  const { script, warnings } = buildFromText({
    text, id: newId(), enabled: true, source, createdAt: Date.now(), fallbackName: filename,
  });
  await saveScript(script);
  const resWarnings = await prefetchResources(script);
  const syncWarnings = await syncBestEffort();
  await recomputeAllTabs().catch(() => {});
  broadcastScriptsChanged('import', [script.id]);
  return { script, warnings: [...warnings, ...resWarnings, ...syncWarnings] };
}

// ---------- 消息接线（spec §7）：11 个 handler + tabs 监听 + 启动自愈 ----------

export function initScriptsModule(router: MessageRouter): void {
  router.on('SCRIPTS_LIST', async () => ({
    ok: true,
    data: {
      scripts: (await listScripts()).map((s) => toSummary(s, gmErrorCounts()[s.id] ?? 0)),
      engineAvailable: engineAvailable(),
    },
  }));

  router.on('SCRIPTS_GET', async (msg) => {
    const { id, offset, limit } = msg as unknown as { id: string; offset?: number; limit?: number };
    return { ok: true, data: await handleGet(id, offset, limit) };
  });

  router.on('SCRIPTS_CREATE', async (msg) => {
    const { script, warnings } = await handleCreate((msg as unknown as { input: ScriptInput }).input);
    return { ok: true, data: { script, warnings } };
  });

  router.on('SCRIPTS_UPDATE', async (msg) => {
    const { id, patch } = msg as unknown as { id: string; patch: ScriptPatch };
    return { ok: true, data: { script: await handleUpdate(id, patch) } };
  });

  router.on('SCRIPTS_DELETE', async (msg) => {
    await handleDelete((msg as unknown as { id: string }).id);
    return { ok: true };
  });

  router.on('SCRIPTS_SET_ENABLED', async (msg) => {
    const { id, enabled } = msg as unknown as { id: string; enabled: boolean };
    return { ok: true, data: { script: await handleSetEnabled(id, enabled) } };
  });

  router.on('SCRIPTS_IMPORT', async (msg) => {
    const { text, filename } = msg as unknown as { text: string; filename?: string };
    const { script, warnings } = await handleImport(text, filename);
    return { ok: true, data: { script, warnings } };
  });

  router.on('SCRIPTS_GET_RUNTIME', async () => ({ ok: true, data: { entries: getRuntimeSnapshot() } }));

  // popup 按 tab 查运行脚本：命中返回该条目，未命中返回 null（popup 显示「本页无脚本」）
  router.on('SCRIPTS_GET_RUNTIME_FOR_TAB', async (msg) => {
    const { tabId } = msg as unknown as { tabId: number };
    const entry = getRuntimeSnapshot().find((e) => e.tabId === tabId) ?? null;
    return { ok: true, data: { entry } };
  });

  // 全屏详情页 XHR 安全区：读该脚本已授权 host、撤销单条授权（幂等）
  router.on('SCRIPTS_GET_PERMISSIONS', async (msg) => {
    const { id } = msg as unknown as { id: string };
    return { ok: true, data: { hosts: await listAllowedHosts(id) } };
  });

  router.on('SCRIPTS_REVOKE_PERMISSION', async (msg) => {
    const { id, host } = msg as unknown as { id: string; host: string };
    await revokeHost(id, host);
    return { ok: true };
  });

  // 脚本详情页「模型调用」档位：读档 + 写档（写档同时清该脚本的会话内授权，档位优先）
  router.on('SCRIPTS_GET_LLM_TIER', async (msg) => {
    const { id } = msg as unknown as { id: string };
    return { ok: true, data: { tier: await getLlmTier(id) } };
  });

  router.on('SCRIPTS_SET_LLM_TIER', async (msg) => {
    const { id, tier } = msg as unknown as { id: string; tier: 'ask' | 'allow' | 'deny' };
    await setLlmTier(id, tier);
    __resetLlmSessionFor(id);
    return { ok: true };
  });

  // 更新编排（spec §2）：URL 导入 / 手动检查 / 应用更新
  router.on('SCRIPTS_IMPORT_URL', async (msg) => {
    const { url } = msg as unknown as { url: string };
    const { script, warnings } = await handleImportUrl(url);
    return { ok: true, data: { script, warnings } };
  });

  router.on('SCRIPTS_CHECK_UPDATE', async (msg) => {
    const { id } = msg as unknown as { id: string };
    const script = await getScript(id);
    if (!script) throw new Error(`脚本不存在：${id}`);
    return { ok: true, data: await checkScriptUpdate(script) };
  });

  router.on('SCRIPTS_APPLY_UPDATE', async (msg) => {
    const { id } = msg as unknown as { id: string };
    return { ok: true, data: { script: await handleApplyUpdate(id) } };
  });

  // 运行态跟踪：url 变化或加载完成时重算该 tab；关闭时清理
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === 'complete') {
      void recomputeTab(tabId, tab.url ?? '');
    }
  });
  browser.tabs.onRemoved.addListener((tabId) => dropTab(tabId));

  // 启动自愈：persistAcrossSessions 理论自持久，扩展更新/注册漂移时对齐；
  // 引擎不可用时静默（UI 靠 SCRIPTS_LIST.engineAvailable 显示警示条）。
  void syncRegistrations().catch(() => {});
  void recomputeAllTabs().catch(() => {});
}
