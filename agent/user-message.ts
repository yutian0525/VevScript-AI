// agent/user-message.ts
// 用户消息组装/还原：把「输入框文本 + 附件」编排成统一 ChatMessage.content，
// 并能从存储里的 content 反解出用于展示的附件列表（切标签/重载后重建气泡内的 tag）。
import type { ContentPart } from './provider/types';
import type { ChatAttachment } from '../shared/types';

/** take_screenshot 注入的 user 图片消息首个文本 part 的哨兵——用于把该图片回挂到工具卡片，
 *  而非渲染成用户气泡（loop.ts 注入端 / chat store 还原端共用，避免魔法串分叉）。 */
export const SCREENSHOT_SENTINEL = '（take_screenshot 返回的页面截图）';

/** 文本附件内联时的包裹头前缀（还原端据此把文本 part 识别回附件）。 */
const ATTACH_HEAD_RE = /^\[附件文件：(.*)\]$/;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** 把用户输入文本 + 附件编排成 content：
 *  - 无附件 → 纯字符串（保留会话标题提取等既有行为）；
 *  - 有附件 → parts 数组：part[0] 恒为用户输入文本，随后是文本附件（内联包裹），最后是图片。 */
export function composeUserContent(text: string, attachments: ChatAttachment[]): string | ContentPart[] {
  if (attachments.length === 0) return text;
  const parts: ContentPart[] = [{ type: 'text', text }];
  for (const a of attachments) {
    if (a.kind === 'text' && a.text != null) {
      parts.push({ type: 'text', text: `[附件文件：${a.name}]\n${a.text}` });
    }
  }
  for (const a of attachments) {
    if (a.kind === 'image' && a.dataUrl) {
      parts.push({ type: 'image_url', imageUrl: a.dataUrl });
    }
  }
  return parts;
}

/** content 是否为 take_screenshot 注入的图片消息（首个文本 part === 哨兵）。 */
export function isScreenshotInjection(content: string | ContentPart[]): boolean {
  if (!Array.isArray(content)) return false;
  const first = content.find((p) => p.type === 'text');
  return first?.type === 'text' && first.text === SCREENSHOT_SENTINEL;
}

/** 从单个文本 part 反解文本附件（命中包裹头则返回，否则 null）。 */
function parseTextAttachment(partText: string): ChatAttachment | null {
  const nl = partText.indexOf('\n');
  const head = nl >= 0 ? partText.slice(0, nl) : partText;
  const m = ATTACH_HEAD_RE.exec(head);
  if (!m) return null;
  const body = nl >= 0 ? partText.slice(nl + 1) : '';
  return { kind: 'text', name: m[1] ?? '文件', size: byteLength(body), text: body };
}

/** 从存储里的 user content 反解出「展示文本 + 附件列表」（供 chat store 还原气泡）。
 *  约定：数组的 part[0] 恒为用户输入文本（不当附件解析），part[1..] 的文本 part 命中包裹头才算附件。 */
export function parseUserContent(content: string | ContentPart[]): { text: string; attachments: ChatAttachment[] } {
  if (typeof content === 'string') return { text: content, attachments: [] };
  let text = '';
  const attachments: ChatAttachment[] = [];
  content.forEach((p, i) => {
    if (p.type === 'image_url') {
      attachments.push({ kind: 'image', name: '图片', size: 0, dataUrl: p.imageUrl });
      return;
    }
    if (i > 0) {
      const att = parseTextAttachment(p.text);
      if (att) { attachments.push(att); return; }
    }
    text += p.text;
  });
  return { text, attachments };
}
