// background/router.ts
// background 侧消息路由：注册 handler 表，按 type 分发（handler 可选接收 sender）。
// 侧边栏与 content script 都通过 browser.runtime.sendMessage 与 background 通信。

/** handler 接收整条消息对象及可选 sender，返回值经 sendResponse 回给发送方 */
export type Handler = (
  msg: { type: string } & Record<string, unknown>,
  sender?: Browser.runtime.MessageSender,
) => unknown;

export class MessageRouter {
  private handlers = new Map<string, Handler>();

  on(type: string, handler: Handler): void {
    this.handlers.set(type, handler);
  }

  async dispatch(
    msg: { type: string } & Record<string, unknown>,
    sender?: Browser.runtime.MessageSender,
  ): Promise<unknown> {
    try {
      const handler = this.handlers.get(msg.type);
      if (!handler) {
        return { ok: false, error: `no handler for ${String(msg.type)}` };
      }
      return await handler(msg, sender);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 挂载 browser.runtime.onMessage 监听（异步响应） */
  attach(): void {
    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      this.dispatch(msg as { type: string } & Record<string, unknown>, sender)
        .then(sendResponse)
        .catch(() => {
          sendResponse({ ok: false, error: 'internal error' });
        });
      return true; // 保持消息通道开放等异步响应
    });
  }
}
