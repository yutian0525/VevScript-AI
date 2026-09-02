// tests/stores/conversations.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { useConversations } from '../../stores/conversations';
import { useChat } from '../../stores/chat';
import { createConversation, appendMessage, setLastPromptTokens } from '../../storage/conversations';

describe('conversations store', () => {
  beforeEach(async () => { fakeBrowser.reset(); useChat.getState().reset(); });

  it('newConversation 设新草稿 id、清空 chat、不写 index', async () => {
    await useConversations.getState().newConversation();
    const st = useConversations.getState();
    expect(st.currentId).toBeTruthy();
    expect(useChat.getState().messages).toEqual([]);
    expect(st.list).toEqual([]); // 草稿未落库
  });

  it('switchTo 载入目标会话消息 + promptTokens', async () => {
    const c = await createConversation();
    await appendMessage(c.id, { role: 'user', content: '历史消息' });
    await setLastPromptTokens(c.id, 4321);
    await useConversations.getState().refreshList();
    await useConversations.getState().switchTo(c.id);
    expect(useConversations.getState().currentId).toBe(c.id);
    expect(useChat.getState().messages.some((m) => m.text === '历史消息')).toBe(true);
    expect(useChat.getState().promptTokens).toBe(4321);
  });

  it('remove 当前会话且尚有其他 → 切到最近一条', async () => {
    const a = await createConversation();
    await appendMessage(a.id, { role: 'user', content: 'A' });
    const b = await createConversation();
    await appendMessage(b.id, { role: 'user', content: 'B' });
    await useConversations.getState().switchTo(a.id);
    await useConversations.getState().remove(a.id);
    // b 更近（后建/后更新）→ 成为当前
    expect(useConversations.getState().currentId).toBe(b.id);
  });

  it('remove 当前会话且无其他 → 开新草稿', async () => {
    const a = await createConversation();
    await appendMessage(a.id, { role: 'user', content: 'A' });
    await useConversations.getState().switchTo(a.id);
    await useConversations.getState().remove(a.id);
    const st = useConversations.getState();
    expect(st.currentId).toBeTruthy();
    expect(st.currentId).not.toBe(a.id);
    expect(st.list).toEqual([]);
  });
});
