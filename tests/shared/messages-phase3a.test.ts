import { describe, it, expect } from 'vitest';
import type { AgentEvent, PortMsgToPanel } from '../../shared/messages';

describe('Phase 3a 协议扩展', () => {
  it('tool-end 可带 image 字段', () => {
    const m: AgentEvent = { type: 'tool-end', name: 'take_screenshot', callId: 'c1', ok: true, summary: '已截图', image: 'data:image/jpeg;base64,X' };
    expect(m.type).toBe('tool-end');
    expect((m as { image?: string }).image).toBe('data:image/jpeg;base64,X');
  });

  it('tool-end 不带 image 仍合法', () => {
    const m: AgentEvent = { type: 'tool-end', name: 'click', callId: 'c2', ok: false, summary: '失败' };
    expect(m.type === 'tool-end' && m.ok).toBe(false);
  });

  it('下行到面板的事件必须带 convId（面板按会话过滤）', () => {
    const m: PortMsgToPanel = { type: 'tool-end', name: 'click', callId: 'c3', ok: true, summary: '成功', convId: 'conv-1' };
    expect(m.convId).toBe('conv-1');
    // 判别收窄仍生效（WithConv 分布式叠加，非整体 intersection）
    if (m.type === 'tool-end') expect(m.ok).toBe(true);
  });
});
