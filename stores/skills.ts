// stores/skills.ts
// 技能池前端状态：与 stores/scripts.ts 同构但极简（无运行态/广播）。
import { create } from 'zustand';
import type { SkillSummary } from '../shared/types';

export async function sendSkillsRequest<T = unknown>(req: unknown): Promise<T> {
  return (await browser.runtime.sendMessage(req)) as T;
}

/** 浮层搜索：仅启用项；command 前缀优先、其余子串（大小写不敏感，纯函数 spec §3.1） */
export function filterSkills(list: SkillSummary[], query: string): SkillSummary[] {
  const q = query.trim().toLowerCase();
  const enabled = list.filter((s) => s.enabled);
  if (!q) return enabled;
  const prefix = enabled.filter((s) => s.command.toLowerCase().startsWith(q));
  const rest = enabled.filter(
    (s) => !s.command.toLowerCase().startsWith(q) &&
      (s.command.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)),
  );
  return [...prefix, ...rest];
}

interface SkillsState {
  list: SkillSummary[];
  loading: boolean;
  refresh: () => Promise<void>;
}

export const useSkills = create<SkillsState>((set) => ({
  list: [],
  loading: false,
  refresh: async () => {
    set({ loading: true });
    try {
      const resp = await sendSkillsRequest<{ ok: boolean; data?: { skills: SkillSummary[] } }>({ type: 'SKILLS_LIST' });
      set({ list: resp.data?.skills ?? [], loading: false });
    } catch {
      set({ loading: false });
    }
  },
}));
