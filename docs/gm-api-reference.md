# GM API 使用参考（本扩展已支持全集）

> 面向脚本作者的**使用手册**：逐个列出本扩展已实现的 GM API——签名、参数、返回、注意、示例。
> 生态盘点与支持状态目录（含三家对比、后续候选、明确不做）见 [gm-api.md](gm-api.md)。
> 已支持总数：**29 个函数型 API + 4 个特殊 grant**（Phase 5 首批 15 + Tier A+B 扩充 14 函数 + 3 特殊 grant）。

## 通用约定

- **@grant 声明即授权**：只有 `@grant` 声明过的 API 才注入脚本上下文。未声明的 API **不存在**（裸引用抛 `ReferenceError`/`undefined is not a function`），不会运行时弹权限窗。
- **@grant none**：不建 GM 沙箱，仅注入 `GM_info` / `GM` 最小对象。
- **双形态**：`GM_xxx` 下划线形式——值/DOM 类**同步**返回（读注入时快照，零 RPC）；`GM.xxx` 点形式统一返回 **Promise**（`GM_info`/`GM.info` 例外，是同引用非 Promise）。下方签名同时给两种。
- **世界**：脚本默认跑在 `USER_SCRIPT`（隔离世界，与页面共享 DOM 但 JS 环境隔离）；`@world MAIN` 跑在页面真实世界。`unsafeWindow` 语义随之不同（见 §11）。
- **跨 tab 广播**：值写操作会广播到匹配同脚本 `@match` 的其它 tab（见 `GM_addValueChangeListener`）。

---

## 1. 信息与元数据

### `GM_info` / `GM.info`

脚本与扩展的元数据快照（构建期直嵌，同步只读）。

```js
// @grant GM_info
GM_info.scriptHandler        // "ai-browser-extend"
GM_info.version              // 扩展版本
GM_info.injectInto           // "UserScript" | "Main"
GM_info.script.name          // 脚本名
GM_info.script.namespace     // @namespace
GM_info.script.version       // @version
GM_info.script.description    // @description
GM_info.script.matches       // @match 数组
GM_info.script.grants        // @grant 数组
```

`GM.info` 与 `GM_info` 同引用（非 Promise）。

---

## 2. 值存储

注入时把当前值快照直嵌进 wrapper——下划线形式**同步**读快照，零 RPC；写操作经桥穿透到 Service Worker 落库并跨 tab 广播。

### `GM_getValue(key, default?)` / `GM.getValue`
读脚本命名空间的持久值。下划线同步返回；缺失键返回 `default`（未传则 `undefined`）。

```js
// @grant GM_getValue
var n = GM_getValue('count', 0);          // 同步
GM.getValue('count', 0).then(function (n) { ... }); // Promise
```

### `GM_setValue(key, value)` / `GM.setValue`
写值（对象经 JSON 往返）。写后同步更新本地快照 + 过桥落库 + 跨 tab 广播。

```js
// @grant GM_setValue
GM_setValue('count', 42);
GM_setValue('conf', { a: 1, b: 'x' });
```

### `GM_deleteValue(key)` / `GM.deleteValue`
删值。

```js
// @grant GM_deleteValue
GM_deleteValue('count');
```

### `GM_listValues()` / `GM.listValues`
列本脚本命名空间全部键（同步返回 `string[]`）。

```js
// @grant GM_listValues
var keys = GM_listValues();  // ['count', 'conf', ...]
```

### `GM_getValues(keysOrDefaults)` / `GM.getValues`
批量读（同步）。参数为**数组**时逐键读快照；为**对象**时以其值作各键默认值。返回 `{key: value}`。

```js
// @grant GM_getValues
GM_getValues(['a', 'b']);            // { a: <val|undefined>, b: ... }
GM_getValues({ a: 0, b: 'def' });    // 缺失键回退到默认值
```

### `GM_setValues(obj)` / `GM.setValues`
批量写（对象每个键一条）。同步更新本地快照 + 过桥 + 逐键广播。

```js
// @grant GM_setValues
GM_setValues({ a: 1, b: 2, c: 3 });
```

### `GM_deleteValues(keys)` / `GM.deleteValues`
批量删（`string[]`）。

```js
// @grant GM_deleteValues
GM_deleteValues(['a', 'c']);
```

### `GM_addValueChangeListener(key, fn)` / `GM.addValueChangeListener`
监听某键变更，返回 listenerId（`"key:idx"`）。回调 `fn(key, oldValue, newValue, remote)`——发起 tab 的本地事件 `remote=false`，其它匹配 tab 收到的跨 tab 事件 `remote=true`。

```js
// @grant GM_addValueChangeListener
var id = GM_addValueChangeListener('count', function (key, oldV, newV, remote) {
  console.log(key, oldV, '→', newV, 'remote=' + remote);
});
```

### `GM_removeValueChangeListener(id)` / `GM.removeValueChangeListener`
按 listenerId 移除监听。

```js
// @grant GM_removeValueChangeListener
GM_removeValueChangeListener(id);
```

---

## 3. 页面与 DOM

### `GM_addStyle(css)` / `GM.addStyle`
注入 `<style>` 到当前 world 的 `<head>`（无则 `documentElement`），同步返回该 style 元素。

```js
// @grant GM_addStyle
var el = GM_addStyle('body { background: #efefef }');
```

### `GM_addElement(tagName, attrs?)` / `GM_addElement(parent, tagName, attrs?)` / `GM.addElement`
创建元素并插入，返回该元素。两种签名：仅 `(tag, attrs)` 插入到 **`document.body`**；`(parent, tag, attrs)` 插入到指定父节点。`attrs` 里 `textContent`/`innerHTML` 特判，其余走 `setAttribute`。

```js
// @grant GM_addElement
var div = GM_addElement('div', { id: 'x', textContent: 'hi', style: 'color:red' });
GM_addElement(document.body, 'img', { src: 'https://…/a.png' });
```

> 注：无 parent 时落 `body`（head 的 UA 样式 `display:none` 会吞掉其中的渲染元素）。`<script>` 元素注入受页面 CSP 约束（与 TM 行为一致）。

---

## 4. 资源

预取管线在保存/更新脚本时同步抓取 `@require`/`@resource`（30s 超时、单文件 ≤2MB、总量 ≤10MB、7 天缓存）。`@require` 一律当代码文本前置拼接；`@resource` 按 content-type 分文本/二进制。

### `GM_getResourceText(name)` / `GM.getResourceText`
读 `@resource` 声明的**文本**资源原文（同步）。二进制资源返回 `undefined`。

```js
// @resource conf https://cdn/conf.json
// @grant GM_getResourceText
var text = GM_getResourceText('conf');
```

### `GM_getResourceURL(name, isBlobUrl?)` / `GM.getResourceUrl`
返回资源的完整 `data:` URL（可喂给 `<img src>` / `<link href>`）。文本资源 `data:{mime};charset=utf-8,…`，二进制 `data:{mime};base64,…`。

```js
// @resource logo https://cdn/logo.png
// @grant GM_getResourceURL
// @grant GM_addElement
var url = GM_getResourceURL('logo');
GM_addElement('img', { src: url });
```

> 注：`isBlobUrl` 参数被忽略（本扩展不做 blob: 生命周期管理，始终返回 data: URL）。

---

## 5. 菜单命令

菜单命令入口在**侧边栏脚本页「菜单命令」区**（非浏览器右键菜单）；点击经 SW 回发到注册来源 tab 触发回调。

### `GM_registerMenuCommand(name, fn)` / `GM.registerMenuCommand`
注册菜单命令，返回 key。

```js
// @grant GM_registerMenuCommand
var key = GM_registerMenuCommand('导出数据', function () { doExport(); });
```

### `GM_unregisterMenuCommand(key)` / `GM.unregisterMenuCommand`
按 key 注销菜单命令。

```js
// @grant GM_unregisterMenuCommand
GM_unregisterMenuCommand(key);
```

---

## 6. 网络

### `GM_xmlhttpRequest(details)` / `GM.xmlHttpRequest`
跨域请求，返回 `{ abort }`。回调 `onload(resp)` / `onerror(resp)` / `ontimeout()`；`resp` 含 `status`/`statusText`/`headers`/`body`/`finalUrl`。

- **@connect 门控**：self（同 host / 页面子域）与 `@connect` 命中直接放行；列了 `@connect` 但不命中直接拒绝；未列入则弹确认卡（允许一次 / 总是允许 / 拒绝，60s 超时按拒绝）。「总是允许」记入授权库。
- 被 fetch 禁的头（`user-agent`/`referer`/`cookie`/`origin`/`host`）忽略，响应 `droppedHeaders` 列出。
- 响应非流式、`≤1MB` 截断（超出 `truncated:true`）；`credentials:'include'`（带会话 cookie）；默认 30s 超时（`details.timeout` 覆盖）。

```js
// @connect api.example.com
// @grant GM_xmlhttpRequest
GM_xmlhttpRequest({
  method: 'GET', url: 'https://api.example.com/data', timeout: 15000,
  headers: { 'X-Token': 'abc' },
  onload: function (resp) { console.log(resp.status, resp.body); },
  onerror: function (resp) { console.warn(resp.error); },
});
```

### `GM_download(details | url, name?)` / `GM.download`
下载文件到本地（`chrome.downloads`，浏览器自带下载条）。两种签名：`GM_download(url, name)` 或 `GM_download({ url, name, headers, saveAs, onload, onerror })`。

- 源 URL 走与 XHR **同一套 @connect 门控**：`@connect` 命中或已「总是允许」→ **直接放行不弹卡**；列了 `@connect` 但不命中 → 拒绝；**未列** `@connect` → 弹确认卡（允许一次 / 总是允许 / 拒绝，60s 超时按拒绝）。
- `state=complete` → `onload()`；`interrupted` → `onerror({error})`；默认 5 分钟未达终态兜底 `onerror`（`details.timeout` 毫秒覆盖）。
- **暂无 `onprogress`**（首版仅 onload/onerror）。

```js
// @connect cdn.example.com
// @grant GM_download
GM_download({
  url: 'https://cdn.example.com/file.zip', name: 'file.zip',
  onload: function () { console.log('done'); },
  onerror: function (e) { console.warn(e.error); },
});
```

### `GM_cookie.list/set/delete(details)` / `GM.cookie.*`
读写站点 cookie（`chrome.cookies`）。`@grant GM_cookie` **一次装齐三方法**；三方法均返回 Promise。目标域（`details.url` 或 `details.domain`）走与 XHR 同一套 @connect 门控。

```js
// @connect example.com
// @grant GM_cookie
GM_cookie.list({ url: location.href }).then(function (cookies) {
  // [{ name, value, domain, path, expirationDate, httpOnly, secure, sameSite }, ...]
});
GM_cookie.set({ url: location.origin + '/', name: 'k', value: 'v', expirationDate: … });
GM_cookie.delete({ url: location.origin + '/', name: 'k' });
```

> 高敏感：cookie 域与网络请求域共用同一 `@connect` 授权库——对某脚本「总是允许 host X」会同时覆盖 XHR / cookie / download。

---

## 7. 标签页

### `GM_openInTab(url, opts?)` / `GM.openInTab`
开新 tab，返回句柄 `{ closed, close(), onclose }`。`opts.active`（默认 true，`false` 后台开）。

```js
// @grant GM_openInTab
var h = GM_openInTab('https://example.com', { active: false });
h.onclose = function () { console.log('closed'); };
// h.close();  // 关掉它
```

### `GM_saveTab(data)` / `GM.saveTab`  ·  `GM_getTab(cb)` / `GM.getTab`  ·  `GM_getTabs(cb)` / `GM.getTabs`
本 tab 私有临时数据。`saveTab` 写、`getTab` 读本 tab、`getTabs` 读全部 tab 的本脚本数据 `{[tabId]: data}`。`getTab`/`getTabs` 支持可选回调，也返回 Promise。

- 存 `chrome.storage.session`（键 `gm-tab:{scriptId}:{tabId}`），**tab/浏览器关闭随会话失效，不持久化**。
- `getTab` 首次返回 `{}`。

```js
// @grant GM_saveTab
// @grant GM_getTab
// @grant GM_getTabs
GM_saveTab({ visited: Date.now() });
GM_getTab(function (data) { console.log(data); });        // 回调
GM.getTab().then(function (data) { ... });                 // Promise
GM_getTabs(function (all) { console.log(all); });          // { '7': {...}, '9': {...} }
```

---

## 8. 通知与剪贴板

### `GM_notification(details, ondone?)` / `GM.notification`
系统通知。`details` = `{ title, text }`。`ondone(why)`——`'click'`（点击）/ `'close'`（关闭）。图标为扩展内占位 PNG。

```js
// @grant GM_notification
GM_notification({ title: '完成', text: '任务已结束' }, function (why) {
  console.log('通知被', why);
});
```

### `GM_closeNotification(id)` / `GM.closeNotification`  ·  `GM_updateNotification(id, details)` / `GM.updateNotification`
按 id 关闭 / 更新已发通知。id 是发通知时你传入的标识（`details.tag` 或自定义）。

```js
// @grant GM_closeNotification
// @grant GM_updateNotification
GM_updateNotification('my-notif', { title: '更新', text: '新正文' });
GM_closeNotification('my-notif');
```

### `GM_setClipboard(text)` / `GM.setClipboard`
写剪贴板（**仅文本**）。经专用 offscreen 文档 + `execCommand('copy')` 写入；失败返回可读错误。

```js
// @grant GM_setClipboard
GM_setClipboard('要复制的文本');
```

---

## 9. 日志

### `GM_log(...args)` / `GM.log`
写本地 `console`，带 `[脚本名]` 前缀。

```js
// @grant GM_log
GM_log('调试信息', { detail: 1 });
```

---

## 10. 大模型（本扩展新增，非 GM 生态标准）

### `GM_llmChat(details)` / `GM.llmChat`
调扩展配置的大模型（OpenAI 兼容，`设置 → 模型设置` 同源配置，脚本不可自选模型）。Promise resolve `{ text, usage, finishReason }`。

- `messages`：`{role: 'system'|'user'|'assistant', content}` 数组；`content` 为字符串或多段 `[{type:'text',text}|{type:'image_url',image_url:{url}}]`（图片 data URL ≤5MB 或 http(s) URL）。
- `onChunk(delta)`：可选，收流式文本增量。
- 权限档 per-script（默认「每次询问」弹确认卡）；载荷 ≤2MB、响应 ≤1MB、默认 120s 超时（`details.timeout` 覆盖）。无 abort / tool 角色 / reasoning 下发。

```js
// @grant GM_llmChat
GM_llmChat({
  messages: [{ role: 'user', content: '总结这段文字：…' }],
  onChunk: function (delta) { process.stdout && process.stdout.write(delta); },
}).then(function (r) { console.log(r.text, r.usage, r.finishReason); });
```

---

## 11. 特殊 grant（非函数）

这些 `@grant` 名不是函数，而是改变脚本运行环境或提供页面能力。

### `unsafeWindow`
页面真实 window。`@world MAIN` 下 = `window`（真页面 window）；`USER_SCRIPT`（默认）下 = 隔离世界 window——要真页面 window 请加 `@world MAIN`。

```js
// @grant unsafeWindow
unsafeWindow.somePageGlobal = 123;
```

### `window.close`
关闭脚本所在 tab（桥 → SW `tabs.remove`）。

```js
// @grant window.close
window.close();
```

### `window.focus`
激活脚本所在 tab（桥 → SW `tabs.update({active:true})`）。

```js
// @grant window.focus
window.focus();
```

### `window.onurlchange`
SPA 路由变化事件（pushState/replaceState/hash）。SW 经 `webNavigation` 主帧导航下行，**双形态**：`window.onurlchange` 属性回调 + `window.addEventListener('urlchange', …)` 事件。

```js
// @grant window.onurlchange
window.onurlchange = function (info) { console.log('URL →', info.url); };
window.addEventListener('urlchange', function (e) { console.log(e.detail.url); });
```

> 注：仅主帧（frameId=0）——iframe 内 SPA 导航不下行。

---

## @grant 速查表

| 组 | @grant 名 |
|---|---|
| 信息 | `GM_info` |
| 值存储 | `GM_getValue` `GM_setValue` `GM_deleteValue` `GM_listValues` `GM_getValues` `GM_setValues` `GM_deleteValues` `GM_addValueChangeListener` `GM_removeValueChangeListener` |
| DOM | `GM_addStyle` `GM_addElement` |
| 资源 | `GM_getResourceText` `GM_getResourceURL`（+ `@resource`） |
| 菜单 | `GM_registerMenuCommand` `GM_unregisterMenuCommand` |
| 网络 | `GM_xmlhttpRequest` `GM_download` `GM_cookie`（+ `@connect`） |
| 标签页 | `GM_openInTab` `GM_getTab` `GM_saveTab` `GM_getTabs` |
| 通知/剪贴板 | `GM_notification` `GM_closeNotification` `GM_updateNotification` `GM_setClipboard` |
| 日志 | `GM_log` |
| 大模型 | `GM_llmChat` |
| 特殊 grant | `unsafeWindow` `window.close` `window.focus` `window.onurlchange` |

共 **29 个函数型 API + 4 个特殊 grant**。

## 已知限制

- **GM_download**：无 `onprogress`（仅 onload/onerror）；未列 @connect 的跨域首次弹确认卡。
- **GM_cookie / GM_download / GM_xmlhttpRequest**：共用同一套 `@connect` + 「总是允许」授权库，授权互相覆盖。
- **GM_getResourceURL**：始终返回 `data:` URL（不做 blob:）；`isBlobUrl` 参数忽略。
- **GM_getTab 系**：`storage.session`，浏览器关闭清空；值经 JSON 序列化（不能含函数/循环引用）。
- **window.close / window.focus**：作用于脚本所在整个 tab（非 window 级）。
- **window.onurlchange**：仅主帧，不覆盖 iframe。
- **GM_setClipboard**：仅文本。
- **GM_registerMenuCommand**：菜单入口在侧边栏脚本页，非浏览器右键菜单。
- **受限页**（`chrome://`、扩展页等）：脚本不注入，GM API 不可用。
