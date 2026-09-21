// storage/composer.ts
// 未发送的输入框草稿。侧边栏在切换标签页时会被销毁重建（同 conversations.ts 的 CURRENT_KEY 语境），
// 组件内的 useState 撑不过重建，草稿落 session 区：同一次浏览器会话内切标签/重开面板都还在，
// 浏览器关闭时随 session 区一起清空。
import { storage } from 'wxt/utils/storage';

const DRAFT_KEY = 'session:composer:draft';

export async function getDraft(): Promise<string> {
  return (await storage.getItem<string>(DRAFT_KEY)) ?? '';
}

/** 空串即视为无草稿：删键而非写字面空串，避免陈旧键常驻 session 区。 */
export async function saveDraft(text: string): Promise<void> {
  if (text) await storage.setItem(DRAFT_KEY, text);
  else await storage.removeItem(DRAFT_KEY);
}
