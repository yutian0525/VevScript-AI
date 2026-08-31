import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getSession, saveSession, appendMessage, setStatus, type Session } from '../../storage/sessions';

describe('sessions storage', () => {
  beforeEach(() => fakeBrowser.reset());

  it('无会话时返回空 idle 会话', async () => {
    const s = await getSession(7);
    expect(s.tabId).toBe(7);
    expect(s.messages).toEqual([]);
    expect(s.status).toBe('idle');
  });

  it('save 后可读回', async () => {
    const s: Session = { tabId: 3, messages: [{ role: 'user', content: 'hi' }], status: 'running', updatedAt: 1 };
    await saveSession(s);
    const got = await getSession(3);
    expect(got.messages).toHaveLength(1);
    expect(got.status).toBe('running');
  });

  it('appendMessage 追加且更新 updatedAt', async () => {
    await appendMessage(5, { role: 'user', content: 'a' });
    await appendMessage(5, { role: 'assistant', content: 'b' });
    const s = await getSession(5);
    expect(s.messages.map((m) => m.content)).toEqual(['a', 'b']);
    expect(s.updatedAt).toBeGreaterThan(0);
  });

  it('appendMessage 超过 200 条时保留最近 200', async () => {
    for (let i = 0; i < 205; i++) await appendMessage(9, { role: 'user', content: String(i) });
    const s = await getSession(9);
    expect(s.messages).toHaveLength(200);
    expect(s.messages[0]!.content).toBe('5');
    expect(s.messages[199]!.content).toBe('204');
  });

  it('setStatus 只改状态不动消息', async () => {
    await appendMessage(2, { role: 'user', content: 'x' });
    await setStatus(2, 'paused');
    const s = await getSession(2);
    expect(s.status).toBe('paused');
    expect(s.messages).toHaveLength(1);
  });

  it('不同 tabId 会话隔离', async () => {
    await appendMessage(1, { role: 'user', content: 'tab1' });
    await appendMessage(2, { role: 'user', content: 'tab2' });
    expect((await getSession(1)).messages[0]!.content).toBe('tab1');
    expect((await getSession(2)).messages[0]!.content).toBe('tab2');
  });
});
