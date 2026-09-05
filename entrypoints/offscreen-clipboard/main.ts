// entrypoints/offscreen-clipboard/main.ts
// offscreen 剪贴板写入页：监听 SW 的 OFFSCREEN_WRITE_CLIPBOARD，用文档上下文的
// navigator.clipboard.writeText 写入（SW 里 navigator.clipboard 为 undefined）。
// 纯动作页无 UI；写入结果经 sendResponse 回传（ok/error），SW 不重试。

interface WriteClipboardMsg {
  type: 'OFFSCREEN_WRITE_CLIPBOARD';
  text: string;
}

browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as WriteClipboardMsg | undefined;
  if (!m || m.type !== 'OFFSCREEN_WRITE_CLIPBOARD') return false; // 非本页消息，交给其它 listener
  navigator.clipboard
    .writeText(String(m.text ?? ''))
    .then(() => sendResponse({ ok: true }))
    .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true; // 异步响应
});
