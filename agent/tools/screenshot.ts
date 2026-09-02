// agent/tools/screenshot.ts
// 截图工具（设计 §5）：激活目标标签 → captureVisibleTab → 降采样压缩。
// compressDataUrl 抽为独立导出以便单测 mock（jsdom 无 OffscreenCanvas）。
// doScreenshot 通过 self.compressDataUrl 调用以便 spy 生效。
import type { ToolResult } from '../../shared/types';
import { getSettings } from '../../storage/settings';
import * as self from './screenshot';

export interface Compressed {
  dataUrl: string;
  width: number;
  height: number;
}

/** 降采样到长边 <= maxEdge，按 format 重编码。真实运行时用 OffscreenCanvas。 */
export async function compressDataUrl(
  dataUrl: string,
  opts: { maxEdge?: number; quality?: number; format?: 'jpeg' | 'png' } = {},
): Promise<Compressed> {
  const maxEdge = opts.maxEdge ?? 1024;
  const quality = opts.quality ?? 0.7;
  const format = opts.format ?? 'jpeg';
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  const out = await canvas.convertToBlob(
    format === 'png' ? { type: 'image/png' } : { type: 'image/jpeg', quality },
  );
  const buf = await out.arrayBuffer();
  const b64 = bytesToBase64(buf);
  return { dataUrl: `data:${mime};base64,${b64}`, width, height };
}

/** ArrayBuffer → base64，分块避免 String.fromCharCode 的 spread 实参上限（大截图必崩）。 */
export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000; // 32KB/块，远低于 V8 实参上限
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function doScreenshot(
  tabId: number,
  args: { format?: 'jpeg' | 'png'; quality?: number },
): Promise<ToolResult> {
  const { agent } = await getSettings();
  if (agent.screenshotPolicy === 'never') {
    return { ok: false, error: '截图已按设置禁用（settings.agent.screenshotPolicy=never）' };
  }
  const format = args.format ?? 'jpeg';
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.active) await browser.tabs.update(tabId, { active: true });
    // captureVisibleTab 的 quality 是 0~100 整数；压缩时再用 args.quality（0~1）二次降质
    const captureOpts = format === 'png' ? { format } : { format, quality: 90 };
    const raw = await browser.tabs.captureVisibleTab(tab.windowId!, captureOpts);
    const compressed = await self.compressDataUrl(raw, { quality: args.quality ?? 0.7, format });
    return {
      ok: true,
      data: { screenshot: compressed.dataUrl, width: compressed.width, height: compressed.height },
    };
  } catch (err) {
    return { ok: false, error: `take_screenshot 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
