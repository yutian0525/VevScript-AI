// tests/stores/conversations.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { useConversations } from '../../stores/conversations';
import { useChat } from '../../stores/chat';
import { createConversation, appendMessage, setLastPromptTokens, setStatus, getCurrentConvId } from '../../storage/conversations';

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
    const c = await createConversation();
    await appendMessage(c.id, { role: 'user', content: 'C' });
    await useConversations.getState().switchTo(a.id);
    await useConversations.getState().remove(a.id);
    // c 最近（后建/后更新）→ 成为当前，而非 b 或任意
    expect(useConversations.getState().currentId).toBe(c.id);
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

  it('rename 往返：建档后改标题刷新列表', async () => {
    const c = await createConversation();
    await appendMessage(c.id, { role: 'user', content: '原始消息' });
    await useConversations.getState().rename(c.id, '新标题');
    await useConversations.getState().refreshList();
    const found = useConversations.getState().list.find((m) => m.id === c.id);
    expect(found?.title).toBe('新标题');
  });

  it('rename 草稿不落库', async () => {
    await useConversations.getState().newConversation();
    const draftId = useConversations.getState().currentId!;
    await useConversations.getState().rename(draftId, 'x');
    await useConversations.getState().refreshList();
    expect(useConversations.getState().list).toEqual([]);
  });

  it('switchTo 无 lastPromptTokens → promptTokens=undefined', async () => {
    const c = await createConversation();
    await appendMessage(c.id, { role: 'user', content: '消息' });
    await useConversations.getState().switchTo(c.id);
    expect(useChat.getState().promptTokens).toBe(undefined);
  });
});

describe('conversations store：当前会话指针（切标签保持 / 重启新开）', () => {
  beforeEach(async () => { fakeBrowser.reset(); useChat.getState().reset(); });

  it('newConversation 把草稿 id 写进 session 指针', async () => {
    await useConversations.getState().newConversation();
    expect(await getCurrentConvId()).toBe(useConversations.getState().currentId);
  });

  it('switchTo 更新 session 指针', async () => {
    const c = await createConversation();
    await appendMessage(c.id, { role: 'user', content: 'A' });
    await useConversations.getState().switchTo(c.id);
    expect(await getCurrentConvId()).toBe(c.id);
  });

  it('init 有指针 → 恢复原会话（切标签回来不新开）', async () => {
    const c = await createConversation();
    await appendMessage(c.id, { role: 'user', content: '未读完的历史' });
    await useConversations.getState().switchTo(c.id);
    // 模拟面板重挂载：store 归零，session 指针仍在
    useChat.getState().reset();
    useConversations.setState({ currentId: null, list: [] });

    await useConversations.getState().init();
    expect(useConversations.getState().currentId).toBe(c.id);
    expect(useChat.getState().messages.some((m) => m.text === '未读完的历史')).toBe(true);
  });

  it('init 无指针 → 开新草稿（浏览器重启后 session 区已被清空）', async () => {
    const c = await createConversation();
    await appendMessage(c.id, { role: 'user', content: '上次的会话' });
    // fakeBrowser.reset() 等价于浏览器关闭：session 存储连同指针一起没了
    const st = useConversations.getState();
    await st.init();
    expect(useConversations.getState().currentId).not.toBe(c.id);
    expect(useChat.getState().messages).toEqual([]);
    // 旧会话还在列表里，只是不再是当前
    expect(useConversations.getState().list.some((m) => m.id === c.id)).toBe(true);
  });

  it('switchTo 保留 storage 记的 running（真伪交给 agent:attach 纠正，不打断任务）', async () => {
    const c = await createConversation();
    await appendMessage(c.id, { role: 'user', content: '跑着的任务' });
    await setStatus(c.id, 'running');
    await useConversations.getState().switchTo(c.id);
    expect(useChat.getState().status).toBe('running');
    expect(useChat.getState().compacting).toBe(false);
  });

  it('init 恢复的会话同样保留 running 状态', async () => {
    const c = await createConversation();
    await appendMessage(c.id, { role: 'user', content: '跑着的任务' });
    await useConversations.getState().switchTo(c.id);
    await setStatus(c.id, 'running');
    useConversations.setState({ currentId: null, list: [] });

    await useConversations.getState().init();
    expect(useChat.getState().status).toBe('running');
  });
});
