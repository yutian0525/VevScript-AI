// entrypoints/offscreen-clipboard/main.ts
// offscreen 剪贴板写入页：监听 SW 的 OFFSCREEN_WRITE_CLIPBOARD，用文档上下文写剪贴板
// （SW 里 navigator.clipboard 为 undefined）。
// 路径选择（实测）：async Clipboard API 的 writeText 要求文档持有焦点——offscreen 文档
// 永远不可见、永无焦点，必报 "Document is not focused"。故走 execCommand('copy') 老路径：
// 建临时 textarea → 选中 → execCommand → 即刻清理。execCommand 不要求文档焦点，
// 离屏文档内稳定可用（TM/VM 的 SW/后台页剪贴板实现同款）。
// 写入结果经 sendResponse 回传（ok/error），SW 不重试。

interface WriteClipboardMsg {
  type: 'OFFSCREEN_WRITE_CLIPBOARD';
  text: string;
}

function copyViaExecCommand(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  // 视觉与滚动零干扰（页面无 UI，防御性固定到角落）
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (!ok) throw new Error('execCommand copy 返回 false');
}

browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as WriteClipboardMsg | undefined;
  if (!m || m.type !== 'OFFSCREEN_WRITE_CLIPBOARD') return false; // 非本页消息，交给其它 listener
  try {
    copyViaExecCommand(String(m.text ?? ''));
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
  return false; // 同步应答，无需保持通道
});
