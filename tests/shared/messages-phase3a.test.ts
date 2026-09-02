import { describe, it, expect } from 'vitest';
import type { PortMsgToPanel } from '../../shared/messages';

describe('Phase 3a 协议扩展', () => {
  it('tool-end 可带 image 字段', () => {
    const m: PortMsgToPanel = { type: 'tool-end', name: 'take_screenshot', callId: 'c1', ok: true, summary: '已截图', image: 'data:image/jpeg;base64,X' };
    expect(m.type).toBe('tool-end');
    expect((m as { image?: string }).image).toBe('data:image/jpeg;base64,X');
  });

  it('tool-end 不带 image 仍合法', () => {
    const m: PortMsgToPanel = { type: 'tool-end', name: 'click', callId: 'c2', ok: false, summary: '失败' };
    expect(m.ok).toBe(false);
  });
});
