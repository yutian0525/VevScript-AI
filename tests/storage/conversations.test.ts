// tests/storage/conversations.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  createConversation, getConversation, saveConversation, appendMessage,
  setStatus, renameConversation, deleteConversation, listConversations,
} from '../../storage/conversations';

describe('conversations storage', () => {
  beforeEach(() => fakeBrowser.reset());

  it('createConversation 生成带 id 的空会话并进 index', async () => {
    const c = await createConversation();
    expect(c.id).toBeTruthy();
    expect(c.messages).toEqual([]);
    expect(c.status).toBe('idle');
    expect(c.title).toBe('新会话');
    const index = await listConversations();
    expect(index.map((m) => m.id)).toContain(c.id);
  });

  it('getConversation 未知 id 返回空 idle（不写 index）', async () => {
    const c = await getConversation('nope');
    expect(c.messages).toEqual([]);
    expect(c.status).toBe('idle');
    expect(await listConversations()).toEqual([]);
  });

  it('首条 user 消息生成标题（前 30 字）并同步 index', async () => {
    const c = await createConversation();
    await appendMessage(c.id, { role: 'user', content: '帮我点掉这个页面上恼人的 cookie 同意弹窗谢谢你了' });
    const got = await getConversation(c.id);
    expect(got.title).toBe('帮我点掉这个页面上恼人的 cookie 同意弹窗谢谢你了'.slice(0, 30));
    const index = await listConversations();
    expect(index.find((m) => m.id === c.id)!.title).toBe(got.title);
  });

  it('已重命名的标题不被后续 user 消息覆盖', async () => {
    const c = await createConversation();
    await renameConversation(c.id, '我的任务');
    await appendMessage(c.id, { role: 'user', content: '别覆盖我' });
    expect((await getConversation(c.id)).title).toBe('我的任务');
  });

  it('appendMessage 超 200 条保留最近 200', async () => {
    const c = await createConversation();
    for (let i = 0; i < 205; i++) await appendMessage(c.id, { role: 'user', content: String(i) });
    const got = await getConversation(c.id);
    expect(got.messages).toHaveLength(200);
    expect(got.messages[0]!.content).toBe('5');
  });

  it('setStatus 只改状态并同步 index', async () => {
    const c = await createConversation();
    await setStatus(c.id, 'running');
    expect((await getConversation(c.id)).status).toBe('running');
    expect((await listConversations()).find((m) => m.id === c.id)!.status).toBe('running');
  });

  it('deleteConversation 移除会话与 index 项', async () => {
    const c = await createConversation();
    await deleteConversation(c.id);
    expect(await listConversations()).toEqual([]);
    expect((await getConversation(c.id)).messages).toEqual([]);
  });

  it('index 按 updatedAt 倒序（最近的在前）', async () => {
    const a = await createConversation();
    await new Promise((r) => setTimeout(r, 2));
    const b = await createConversation();
    await new Promise((r) => setTimeout(r, 2));
    await appendMessage(a.id, { role: 'user', content: 'x' }); // a 更新，应排到最前
    const index = await listConversations();
    expect(index[0]!.id).toBe(a.id);
    expect(index[1]!.id).toBe(b.id);
  });

  it('会话之间上下文隔离', async () => {
    const a = await createConversation();
    const b = await createConversation();
    await appendMessage(a.id, { role: 'user', content: 'A的话' });
    await appendMessage(b.id, { role: 'user', content: 'B的话' });
    expect((await getConversation(a.id)).messages[0]!.content).toBe('A的话');
    expect((await getConversation(b.id)).messages[0]!.content).toBe('B的话');
  });
});
