// tests/storage/conversations.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  createConversation, getConversation, saveConversation, appendMessage,
  setStatus, renameConversation, deleteConversation, listConversations,
  setLastPromptTokens, setSummary,
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

  it('首条 user 消息生成标题——短于 30 字不截断', async () => {
    const c = await createConversation();
    const short = '帮我点掉弹窗';
    await appendMessage(c.id, { role: 'user', content: short });
    const got = await getConversation(c.id);
    expect(got.title).toBe(short);
    const index = await listConversations();
    expect(index.find((m) => m.id === c.id)!.title).toBe(short);
  });

  it('首条 user 消息生成标题——超过 30 字截断为 30 字', async () => {
    const c = await createConversation();
    // 39 字符的输入，前 30 字符应为：第一二三四五六七八九十两三四五六七八九十三三四五六七八九十四
    const long = '第一二三四五六七八九十两三四五六七八九十三三四五六七八九十四123456789';
    await appendMessage(c.id, { role: 'user', content: long });
    const got = await getConversation(c.id);
    expect(got.title).toBe('第一二三四五六七八九十两三四五六七八九十三三四五六七八九十四');
    expect(got.title.length).toBe(30);
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

  it('setLastPromptTokens 写回 token 数且不动消息', async () => {
    const c = await createConversation();
    await appendMessage(c.id, { role: 'user', content: 'hi' });
    await setLastPromptTokens(c.id, 4321);
    const got = await getConversation(c.id);
    expect(got.lastPromptTokens).toBe(4321);
    expect(got.messages).toHaveLength(1);
    expect(got.messages[0]!.content).toBe('hi');
  });

  it('setSummary 写回摘要且不动消息', async () => {
    const c = await createConversation();
    await appendMessage(c.id, { role: 'user', content: 'hi' });
    await setSummary(c.id, { text: '前情', coversUpTo: 3 });
    const got = await getConversation(c.id);
    expect(got.summary).toEqual({ text: '前情', coversUpTo: 3 });
    expect(got.messages).toHaveLength(1);
    expect(got.messages[0]!.content).toBe('hi');
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

  // 下面两条钉住一条反直觉的不变量，别拿 createdAt 判「会话是否已落库」。
  it('草稿 id 经 appendMessage 建档：updatedAt 被刷新，createdAt 永久停在 0', async () => {
    // 侧边栏「新会话」是客户端草稿 id（stores/conversations.ts 的 newConversation 不落库），
    // 首条消息经 appendMessage → getConversation(返回 EPOCH 空壳) → saveConversation 建档，
    // 而 saveConversation 只刷新 updatedAt，于是哨兵值 0 被永久写进 createdAt。
    const draftId = 'draft-abc';
    await appendMessage(draftId, { role: 'user', content: '你好' });
    const conv = await getConversation(draftId);
    expect(conv.title).toBe('你好');
    expect(conv.messages).toHaveLength(1);
    expect(conv.updatedAt).toBeGreaterThan(0);
    expect(conv.createdAt).toBe(0);
    expect((await listConversations()).map((m) => m.id)).toContain(draftId);
  });

  it('「从未落库」的判据是 updatedAt === 0（createdAt 不可用）', async () => {
    // createConversation 走的是另一条路径，它把 createdAt 设对了；只有草稿出生的会话是 0。
    // 故 updatedAt 是唯一可靠的哨兵——saveConversation 每次都会刷新它。
    const created = await createConversation();
    const fetched = await getConversation(created.id);
    expect(fetched.updatedAt).toBeGreaterThan(0);
    expect(fetched.createdAt).toBeGreaterThan(0);

    const neverSaved = await getConversation('never-saved');
    expect(neverSaved.updatedAt).toBe(0);
    expect(neverSaved.createdAt).toBe(0);
  });
});
