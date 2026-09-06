// components/chat/attachments.ts
// 输入框附件的分类 / 读取 / 图片降采样。纯函数（classifyFile / formatBytes / 上限常量）
// 可单测；读文件与画布压缩用浏览器 API（jsdom 不覆盖，仅运行时用）。
import type { ChatAttachment } from '../../shared/types';

/** 单次最多附件数（防一次贴一堆撑爆上下文） */
export const MAX_ATTACHMENTS = 8;
/** 纯文本附件字节上限（256KB） */
export const MAX_TEXT_BYTES = 256 * 1024;
/** 图片降采样长边上限 */
export const MAX_IMAGE_EDGE = 1536;
/** 图片重编码 JPEG 质量 */
const IMAGE_QUALITY = 0.8;

/** 视作纯文本的扩展名（type 为空时的兜底判断——代码文件常无 MIME 类型）。 */
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'jsonc', 'xml', 'yaml', 'yml',
  'html', 'htm', 'css', 'scss', 'less', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh',
  'bash', 'zsh', 'sql', 'toml', 'ini', 'conf', 'env', 'gitignore', 'vue', 'svelte',
]);

/** 视作纯文本的 application/* MIME（text/* 之外常见的文本型）。 */
const TEXT_APP_MIME = new Set([
  'application/json', 'application/xml', 'application/javascript',
  'application/x-javascript', 'application/typescript', 'application/x-sh',
  'application/x-yaml', 'application/yaml',
]);

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** 按 MIME + 扩展名分类。返回 unsupported 表示既非文本也非图片。 */
export function classifyFile(file: { name: string; type: string }): 'text' | 'image' | 'unsupported' {
  const type = (file.type || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('text/')) return 'text';
  if (TEXT_APP_MIME.has(type)) return 'text';
  // type 为空 / 未知：靠扩展名兜底
  if (TEXT_EXTS.has(ext(file.name))) return 'text';
  return 'unsupported';
}

/** 字节数 → 人类可读（B / KB / MB）。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 估算 data URL 的字节大小（base64 段长度 × 3/4）。 */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

// ---------- 运行时 IO（浏览器 API，jsdom 不覆盖）----------

/** 读取文本文件为 UTF-8 字符串。 */
export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
    reader.readAsText(file);
  });
}

/** 把图片降采样到长边 <= MAX_IMAGE_EDGE 并重编码为 JPEG dataURL。
 *  小图（本就在上限内）仍会重绘一次以统一格式/去除元数据。失败则抛错。 */
export async function downscaleImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布上下文');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: IMAGE_QUALITY });
    return await blobToDataUrl(blob);
  } finally {
    bitmap.close();
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('编码失败'));
    reader.readAsDataURL(blob);
  });
}

/** 把单个 File 转成 ChatAttachment；不支持的类型 / 超限返回 { error }。 */
export async function fileToAttachment(file: File): Promise<ChatAttachment | { error: string }> {
  const kind = classifyFile(file);
  if (kind === 'unsupported') return { error: `不支持的文件类型：${file.name}` };
  if (kind === 'text') {
    if (file.size > MAX_TEXT_BYTES) {
      return { error: `文本文件过大（${formatBytes(file.size)} > ${formatBytes(MAX_TEXT_BYTES)}）：${file.name}` };
    }
    const text = await readTextFile(file).catch(() => null);
    if (text == null) return { error: `读取失败：${file.name}` };
    return { kind: 'text', name: file.name, size: file.size, text };
  }
  const dataUrl = await downscaleImage(file).catch((e) => {
    console.warn('[attachments] 图片处理失败', e);
    return null;
  });
  if (!dataUrl) return { error: `图片处理失败：${file.name}` };
  return { kind: 'image', name: file.name, size: dataUrlBytes(dataUrl), dataUrl };
}
