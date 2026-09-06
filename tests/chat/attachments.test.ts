// tests/chat/attachments.test.ts
import { describe, it, expect } from 'vitest';
import { classifyFile, formatBytes, dataUrlBytes } from '../../components/chat/attachments';

describe('classifyFile', () => {
  it('image/* → image', () => {
    expect(classifyFile({ name: 'a.png', type: 'image/png' })).toBe('image');
    expect(classifyFile({ name: 'a.jpg', type: 'image/jpeg' })).toBe('image');
  });

  it('text/* → text', () => {
    expect(classifyFile({ name: 'a.txt', type: 'text/plain' })).toBe('text');
    expect(classifyFile({ name: 'a.html', type: 'text/html' })).toBe('text');
  });

  it('文本型 application/* → text', () => {
    expect(classifyFile({ name: 'a.json', type: 'application/json' })).toBe('text');
  });

  it('type 为空时靠扩展名兜底（代码文件常无 MIME）', () => {
    expect(classifyFile({ name: 'main.ts', type: '' })).toBe('text');
    expect(classifyFile({ name: 'go.mod', type: '' })).toBe('unsupported'); // 未列入扩展名表
    expect(classifyFile({ name: 'config.yaml', type: '' })).toBe('text');
  });

  it('二进制/未知 → unsupported', () => {
    expect(classifyFile({ name: 'a.pdf', type: 'application/pdf' })).toBe('unsupported');
    expect(classifyFile({ name: 'a.zip', type: 'application/zip' })).toBe('unsupported');
    expect(classifyFile({ name: 'a.exe', type: '' })).toBe('unsupported');
  });

  it('扩展名大小写不敏感', () => {
    expect(classifyFile({ name: 'README.MD', type: '' })).toBe('text');
  });
});

describe('formatBytes', () => {
  it('B / KB / MB 分档', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('dataUrlBytes', () => {
  it('估算 base64 段字节（含 padding 修正）', () => {
    // "ZZZ" 无 padding：3 * 3/4 = 2
    expect(dataUrlBytes('data:image/jpeg;base64,ZZZ')).toBe(2);
    // 4 字符含一个 = padding → 3 - 1 = 2
    expect(dataUrlBytes('data:image/png;base64,QUJD')).toBe(3);
  });

  it('无 data 前缀时按整串算', () => {
    expect(dataUrlBytes('QUJD')).toBe(3);
  });
});
