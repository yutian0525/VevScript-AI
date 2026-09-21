// shared/observe.ts
// 观测数据的跨环境共享形状。原在 shared/hook-bridge.ts，hook 退役后独立成文件
// （hook-bridge 里的 window 桥协议与 hook 一同删除，ConsoleEntry 本身仍被 CDP 通道使用）。

/** 一条 console 观测。 */
export interface ConsoleEntry {
  id: string;      // 去重键（hook 时代为 `${loadNonce}:${seq}`，CDP 时代为 `cdp:${seq}`）
  level: string;   // log/info/warn/error/debug
  text: string;    // 序列化后的文本（已截断）
  ts: number;      // 采集时间戳
  url?: string;    // 采集时页面 URL
}
