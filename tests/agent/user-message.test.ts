// tests/agent/user-message.test.ts
import { describe, it, expect } from 'vitest';
import {
  composeUserContent,
  parseUserContent,
  isScreenshotInjection,
  SCREENSHOT_SENTINEL,
} from '../../agent/user-message';
import type { ChatAttachment } from '../../shared/types';

const textAtt = (name: string, text: string): ChatAttachment => ({ kind: 'text', name, size: text.length, text });
const imgAtt = (dataUrl: string): ChatAttachment => ({ kind: 'image', name: 'p.png', size: 0, dataUrl });

describe('composeUserContent', () => {
  it('无附件 → 纯字符串', () => {
    expect(composeUserContent('你好', [])).toBe('你好');
  });

  it('有文本附件 → parts[0] 为用户文本，附件内联包裹', () => {
    const content = composeUserContent('看这个', [textAtt('a.md', '# 标题')]);
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string; text?: string }>;
    expect(parts[0]).toEqual({ type: 'text', text: '看这个' });
    expect(parts[1]).toEqual({ type: 'text', text: '[附件文件：a.md]\n# 标题' });
  });

  it('图片附件 → image_url part 排在文本之后', () => {
    const content = composeUserContent('', [imgAtt('data:image/jpeg;base64,ZZZ')]);
    const parts = content as Array<{ type: string; imageUrl?: string }>;
    expect(parts[0]).toEqual({ type: 'text', text: '' });
    expect(parts.find((p) => p.type === 'image_url')).toEqual({ type: 'image_url', imageUrl: 'data:image/jpeg;base64,ZZZ' });
  });

  it('混合附件保持「文本先、图片后」顺序', () => {
    const content = composeUserContent('q', [imgAtt('data:image/png;base64,I'), textAtt('t.txt', 'hi')]);
    const parts = content as Array<{ type: string }>;
    expect(parts.map((p) => p.type)).toEqual(['text', 'text', 'image_url']);
  });
});

describe('parseUserContent（roundtrip 还原）', () => {
  it('纯字符串还原为 text + 空附件', () => {
    expect(parseUserContent('你好')).toEqual({ text: '你好', attachments: [] });
  });

  it('文本附件 roundtrip', () => {
    const atts = [textAtt('a.md', '# 标题\n正文')];
    const content = composeUserContent('看这个', atts);
    const back = parseUserContent(content);
    expect(back.text).toBe('看这个');
    expect(back.attachments).toHaveLength(1);
    expect(back.attachments[0]).toMatchObject({ kind: 'text', name: 'a.md', text: '# 标题\n正文' });
  });

  it('图片附件 roundtrip（还原出 dataUrl）', () => {
    const content = composeUserContent('图', [imgAtt('data:image/jpeg;base64,ZZZ')]);
    const back = parseUserContent(content);
    expect(back.text).toBe('图');
    expect(back.attachments[0]).toMatchObject({ kind: 'image', dataUrl: 'data:image/jpeg;base64,ZZZ' });
  });

  it('用户输入文本本身长得像附件头也不误判（part[0] 永远是文本）', () => {
    const content = composeUserContent('[附件文件：伪装]\n其实是我打的', []);
    // 无附件时是纯字符串，原样还原
    expect(parseUserContent(content)).toEqual({ text: '[附件文件：伪装]\n其实是我打的', attachments: [] });
  });
});

describe('isScreenshotInjection', () => {
  it('首个文本 part 命中哨兵 → true', () => {
    const content = [
      { type: 'text' as const, text: SCREENSHOT_SENTINEL },
      { type: 'image_url' as const, imageUrl: 'data:image/jpeg;base64,ZZZ' },
    ];
    expect(isScreenshotInjection(content)).toBe(true);
  });

  it('用户上传的图片消息（非哨兵文本） → false', () => {
    const content = composeUserContent('我的图', [imgAtt('data:image/png;base64,I')]);
    expect(isScreenshotInjection(content)).toBe(false);
  });

  it('纯字符串 → false', () => {
    expect(isScreenshotInjection('你好')).toBe(false);
  });
});
