# GM_llmChat —— 脚本调用大模型 设计

日期：2026-09-05
分支：feat/script-optimize（worktree `.claude/worktrees/feat+script-optimize`）
状态：设计已确认（用户 ok），待实现计划

## 1. 目标与背景

用户脚本获得调用大模型的能力：传文本与图片、流式接收增量。模型配置完全复用扩展现有
`storage/settings.ts` 的 `provider`（baseUrl/apiKey/model/extraBody）——脚本不可自选模型、
不可覆盖配置。每次调用需经用户权限闸门（确认卡），权限档位 per-script 可设，默认「每次询问」。

不做的事（YAGNI）：abort 中止流式、频率限流、脚本自选模型/覆盖 provider 配置、
多轮对话服务端记忆（每次调用独立）。

## 2. API 形态

### 2.1 签名

```js
const result = await GM_llmChat({
  messages: [                        // OpenAI 风格，必填、非空
    { role: 'system', content: '你是翻译' },
    { role: 'user', content: [       // content 也可为数组（多模态）
      { type: 'text', text: '图里是什么' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
    ]},
  ],
  onChunk: (delta) => {...},         // 可选，流式增量回调（纯文本增量）
  timeout: 120_000,                  // 可选，整调用超时 ms，默认 120_000
});
// result = { text, usage: { promptTokens, completionTokens }, finishReason }
```

- 下划线/点形式（`GM.llmChat`）都返回 Promise（注册表 `promiseForm: true`）。
- `role` 仅接受 `system/user/assistant`；`tool` 角色不开放（脚本无工具循环场景）。
- 图片支持 `data:image/*`（≤5MB）或 http(s) URL（原样透传给 provider）。
- `onChunk` 只收文本增量（`reasoning-delta` 不下发；`tool-call-delta` 不存在——不传 tools）。

### 2.2 返回

| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | `string` | 全部 text-delta 聚合 |
| `usage` | `{ promptTokens?, completionTokens? }` | 网关返回则带，否则缺省 |
| `finishReason` | `string?` | stop/length 等，网关返回则带 |

失败时 Promise reject `Error`（消息见 §4 错误表）。

## 3. 架构：桥接三层 + 复用 provider

与现有 GM API 同构（方案取舍见 §8）：

```
页面脚本（USER_SCRIPT/MAIN world）
  GM_llmChat({messages, onChunk})
    ↓ gmreq:<scriptId> CustomEvent（token 防伪）
ISOLATED content 宿主（content/gm-bridge-host.ts，透传不改）
    ↓ runtime.sendMessage GM_API_CALL
SW：background/gm-api.ts 新 case 'LlmChat'
  → grant 白名单（@grant GM_llmChat）
  → 权限档检查（ask/allow/deny，§5）
  → 参数校验 + 限幅（§6）
  → OpenAICompatProvider.streamChat（复用 getSettings().provider）
  → 逐 chunk 经 GM_EVENT('LLM_CHUNK') 下行
    ↓ tabs.sendMessage → 宿主 handleGmEvent → gmevt:<scriptId> 页面事件
wrapper onChunk 回调；流结束 gmres resolve 终值
```

## 4. 桥协议扩展（最小集）

### 4.1 注册表（shared/gm-apis.ts）

```ts
GM_llmChat: { impl: 'bridge', promiseForm: true },
```

### 4.2 下行事件（shared/gm-bridge.ts）

`GmEventKind` 增加 `'LLM_CHUNK'`，data 形状：

```ts
{ chan: string; delta: string }   // chan = 调用通道号
```

### 4.3 通道号（为什么不用 reqId）

`GM_EVENT` 经 `sendGmEvent` 广播到所有匹配 tab 的所有帧；reqId 只在单帧内自增，
多帧（iframe 同脚本）并发调用会串线。新增调用级通道号：

```
chan = `${页实例随机id}:${reqId}`
```

页实例随机 id 在 preamble 顶层生成一次（每次注入唯一），reqId 沿用现有自增序列。

### 4.4 wrapper（shared/gm-wrapper.ts）

- preamble 顶层新增 `var __GM_inst = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);`
- 拆出 `__GM_post_id(api, params, reqId)`（显式 reqId 版）；`__GM_post` 改为其自增包装（行为不变）。
- gmevt 分发器增加 `LLM_CHUNK` 分支：`var cb = __GM_listeners.get('llmchan:' + d.data.chan); if (cb) cb(d.data.delta);`
- `GM_INSTALLS` 新增：

```
['GM_llmChat', 'function (details) { ... }']
```

实现要点（生成代码内）：
1. `details = __GM_plain(details)` 前先摘出 `onChunk` 存闭包变量；
2. `var chan = __GM_inst + ':' + (++__GM_reqSeq); var reqId = <同一自增值>;`
   （注意 reqId 与 chan 尾段一致：先 `++__GM_reqSeq` 取值，两处共用）；
3. `__GM_listeners.set('llmchan:' + chan, onChunk)`（onChunk 存在才注册）；
4. `__GM_post_id('LlmChat', [details], reqId).then(function (r) { __GM_listeners.delete('llmchan:' + chan); return r; }, function (e) { __GM_listeners.delete('llmchan:' + chan); throw e; })`——成功/失败都清理监听；
5. 下划线形式直接返回 Promise（`promiseForm: true`，点形式由 emit 的包装层补 Promise.resolve）；不提供 abort（已知差异，文档明示）。

### 4.5 grant 映射（background/gm-api.ts）

`API_TO_GRANT` 增加 `LlmChat: 'GM_llmChat'`。bridge 短名经白名单校验。

## 5. 权限档（per-script 三档）

### 5.1 存储（background/gm-permissions.ts 扩展）

```ts
interface PermissionsShape {
  [scriptId: string]: {
    cors: Record<string, 'allow'>;
    llm?: 'ask' | 'allow' | 'deny';   // 缺省 = 'ask'
  };
}
```

新增：`getLlmTier(scriptId): Promise<'ask'|'allow'|'deny'>`（缺省 ask）、
`setLlmTier(scriptId, tier)`。`removeScriptPermissions` 语义不变（整条删除自然覆盖）。

### 5.2 会话内允许（SW 内存态）

`background/gm-api.ts` 新增 `const llmSessionAllow = new Set<string>()`（scriptId）。

- 「本会话内允许」→ `llmSessionAllow.add(scriptId)`；
- SW 重启自然失效（与菜单表同款取舍）；
- 档位变更（`SCRIPTS_SET_LLM_TIER` handler）时同步 `llmSessionAllow.delete(scriptId)`
  （scripts.ts 编排层与 gm-api.ts 同模块 import，直接调用）。

### 5.3 决策流程（case 'LlmChat' 内）

```
tier = await getLlmTier(scriptId)
deny  → reject 'permission denied: 大模型调用已被用户设置为「始终拒绝」'
allow → 放行
ask   → llmSessionAllow.has(scriptId) ? 放行
        : enqueueConfirm({ kind: 'llm', ... })
          → 'allow-once'  → 放行（一次性）
          → 'session'     → llmSessionAllow.add(scriptId); 放行
          → 'deny'/超时/关hub → reject（同 deny 文案，但提示可在脚本设置改档位）
```

确认卡规格（`shared/confirm.ts` `ConfirmKind` 联合增加 `'llm'`；队列/页面零改动——
kind 仅供生产者区分来源）：

| 项 | 值 |
|---|---|
| title | `大模型调用确认` |
| message | `脚本「{name}」请求调用大模型` |
| rows | 脚本 / 模型（mono）/ 消息数（mono）/ 载荷大小（KB，mono） |
| actions | `{ decision: 'allow-once', label: '允许一次', variant: 'primary' }` · `{ decision: 'session', label: '本会话内允许' }` · `{ decision: 'deny', label: '拒绝', variant: 'danger', countdown: true }` |
| timeoutMs | `60_000`（超时按拒绝） |

### 5.4 设置 UI（脚本详情页「设置」Tab）

`components/detail/DetailSettingsTab.tsx` 在「XHR 安全」下方新增「模型调用」区：

- 三选一（复用现有 detail 表单样式）：`每次询问（默认）` / `始终允许` / `始终拒绝`；
- 提示文案：说明三档含义 + 「始终允许/拒绝立即生效；改为其它档位会同时清除本会话内授权」；
- 消息对（`shared/messages.ts` + `background/scripts.ts` 路由）：
  `SCRIPTS_GET_LLM_TIER { id } → { ok, data: { tier } }`、
  `SCRIPTS_SET_LLM_TIER { id, tier } → { ok }`。

## 6. SW 实现（background/gm-api.ts case 'LlmChat'）

### 6.1 参数校验与限幅（在 grant/权限检查之后、provider 调用之前）

| 检查 | 失败文案 |
|---|---|
| `provider.baseUrl/apiKey/model` 非空 | `模型未配置：请到侧边栏 设置 → 模型设置 配置后重试` |
| messages 非空数组 | `缺少 messages 或为空` |
| role ∈ {system,user,assistant} | `非法 role: {r}（仅支持 system/user/assistant）` |
| content 形状（string 或 part 数组） | `非法 content（应为字符串或 {type,...} 数组）` |
| part.type ∈ {text,image_url} | `非法 content part type: {t}` |
| image_url 单张 data URL ≤ 5MB | `图片过大：{n}（上限 5MB）` |
| 消息总载荷 JSON.stringify ≤ 2MB | `消息载荷过大：{KB}KB（上限 2MB）` |
| timeout 非负数 | `非法 timeout` |

http(s) 图片 URL 不做预检/抓取，原样透传（由模型网关自取）。

### 6.2 provider 复用

```ts
const { provider } = await getSettings();
const llm = new OpenAICompatProvider(provider);   // 字段与 ProviderConfig 兼容
```

`OpenAICompatProvider` 为纯 TS（fetch + 手写 SSE），SW 可直接 import。
`ChatParams.tools` 传 `[]`（provider 会省略 tools 字段）；`maxTokens` 不传（不设上限）。
`ChatMessage` 直接用脚本传参映射（role 白名单已校验；content string / ContentPart[] 两态与
`agent/provider/types.ts` 的 `ChatMessage.content` 完全同形）。

### 6.3 流式与 chunk 下行

```
聚合 text = ''
provider.streamChat({ messages }, onEvent)
  text-delta   → text += t; 入队 sendGmEvent(tabId, scriptId, 'LLM_CHUNK', { chan, delta: t })
  reasoning-delta → 忽略
  error        → 记下错误（流仍会以 message-done 终止）
  message-done → 记 usage/finishReason，跳出
await 队列排空（逐个 await sendGmEvent）→ 返回 { ok: true, data: { text, usage, finishReason } }
```

- **有序性**：promise 链逐个 `await`，gmres resolve 必然晚于所有 LLM_CHUNK 到达——
  wrapper 端 onChunk 先收全增量、随后 Promise resolve 终值，时序确定。
- **超时**：`AbortController` + `setTimeout(details.timeout ?? 120_000)`，abort 时
  `streamChat.cancel()`；错误文案 `LLM 调用超时（{ms}ms）`。
- **响应限幅**：聚合 text 长度 > 1MB 时 cancel 流并 reject
  `响应过大：超 1MB 上限`（不返回截断文本，避免脚本误用半截结果）。

### 6.4 错误文案汇总

| 场景 | 错误消息 |
|---|---|
| grant 未声明 | `permission not requested: GM_llmChat（@grant 未声明）`（既有路径） |
| 模型未配置 | `模型未配置：请到侧边栏 设置 → 模型设置 配置后重试` |
| 参数/限幅 | 见 §6.1 表 |
| 权限档 deny / 确认拒绝 | `permission denied: 大模型调用已被用户拒绝（可在脚本详情 → 设置 → 模型调用 改档位）` |
| 确认超时 | 同上（文案不区分，卡上已有倒计时提示） |
| provider 流错误 | `LLM 调用失败: {err}` |
| 超时 | `LLM 调用超时（{ms}ms）` |

## 7. 调试台 / 文档 / 手测脚本

### 7.1 调试台

- GM API 列表读 `GM_API_REGISTRY`，自动出现 `GM_llmChat` 行（tag 分组不变）。
- 直调 `debugCall(scriptId, 'LlmChat', [{ messages: [...] }])` 走真实桥拿最终结果；
  无 onChunk（函数不过桥），chunk 因无匹配通道自然丢弃——直调语义 = 非流式调用，
  文档明示。

### 7.2 docs/gm-api.md

补 `GM_llmChat` 章节：签名、示例（文本/流式/多模态）、权限档说明、限制表
（图片 5MB/载荷 2MB/响应 1MB/超时默认 120s）、已知差异（无 abort、无 tool 角色、
单轮非对话式、reasoning 不下发）。

### 7.3 手测脚本（fixtures/userscripts/manual/llm.user.js.src）

经 `scripts/build-manual.mjs` 拼接产出 `gmt-manual-llm.user.js`，沿用 `_panel-core.js`
面板（render/cards/actions 三件套），卡片：

| id | API | 内容 | 预期 |
|---|---|---|---|
| l1 | `GM_llmChat` 文本单轮 | await 一次调用，日志 text/usage/finishReason | 正常返回 |
| l2 | `GM_llmChat` 流式 | onChunk 逐条日志增量，结束后终值 | 增量若干条 + 终值 text 一致 |
| l3 | 多模态 | canvas 生成 64×64 红色方块 data URL 传入 | 返回描述色块 |
| l4 | 权限档 deny | 脚本设置改「始终拒绝」后调用 | 报 permission denied |
| l5 | 超限 | canvas 画大图（>5MB data URL） | 报「图片过大」 |
| l6 | 未授权 grant | 另建临时脚本（无 @grant GM_llmChat）调用 | 报 permission not requested |

l4/l6 需要外部操作（改设置/导入临时脚本），卡片步骤里写明操作指引（与现有
network 模块「确认卡分支引导」同款做法：脚本内置临时脚本文本供复制导入）。

## 8. 方案取舍记录

| 方案 | 结论 |
|---|---|
| A. 桥接三层 + 复用 provider | **采用**：与 GM API 架构一致，token 防伪/grant 白名单/错误缓冲/调试台全继承 |
| B. 脚本直连 provider（GM_xmlhttpRequest 打 baseUrl） | 否决：apiKey 必然落进页面世界，泄露面不可控 |
| 流式形态：onChunk 回调 + Promise | 采用（备选 AsyncIterable / 纯回调句柄——与现有 promiseForm 双形态约定不符） |
| 参数形态：messages 数组 | 采用（备选扁平 prompt+images——与 provider ChatMessage 不同形，多轮别扭） |
| 权限粒度：脚本级三档 | 采用（无 host 级概念——LLM 调用没有跨域主机维度） |
| 限流：仅限体积 | 采用（频率限流首版不做） |

## 9. 测试

单测（vitest，沿用现有分层）：

| 文件 | 覆盖 |
|---|---|
| `tests/shared/gm-apis.test.ts` | 注册表含 GM_llmChat（impl/promiseForm）、classifyGrants |
| `tests/shared/gm-wrapper.test.ts` | GM_llmChat 安装表达式：onChunk 摘除与注册、chan 生成、成功/失败清理监听、点形式 Promise 包装 |
| `tests/background/gm-permissions.test.ts` | llm 档缺省 ask、set/get 往返、removeScriptPermissions 整删 |
| `tests/background/gm-api.test.ts` | 三档决策（deny 直接拒 / ask 弹卡三决策 / session 命中免卡）、参数校验全表、限幅（图片/载荷/响应）、chunk 有序性（fake provider 按序触发 text-delta，断言下行序）、provider 注入 fake |

## 10. 已知差异与限制（文档明示）

1. 无 abort：GM_llmChat 不提供中止（GM_xmlhttpRequest 的 abort 为一次性语义占位，同款）；
2. 无 tool 角色、无 tools 传参：脚本无工具循环场景；
3. reasoning 不下发：思考文本只存在于 agent 会话链路，脚本只收正文增量；
4. 单轮非对话式：每次调用独立，无服务端会话记忆；
5. 「本会话内允许」为 SW 内存态：SW 重启后回到档位语义（ask 则重新弹卡）；
6. 直调（调试台）为非流式语义：无 onChunk 通道。
