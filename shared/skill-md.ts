// shared/skill-md.ts
// Skill .md 文件解析/序列化（纯函数，spec §1.3）。
// frontmatter 手写最小解析：跳过前导空行后，首行 --- 到下一行 --- 之间逐行 key: value，多余键忽略。

export interface SkillMdFields {
  name: string;
  description: string;
  command: string;
  content: string;
}

export type ParseSkillResult =
  | { ok: true; skill: SkillMdFields; warnings: string[] }
  | { ok: false; error: string };

/** command 格式（storage/skills.ts 共用） */
export const SKILL_COMMAND_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 单文档解析。filename 用于缺 name 时的兜底（去 .md 后缀）。 */
export function parseSkillMd(text: string, filename?: string): ParseSkillResult {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i += 1;
  if (lines[i]?.trim() !== '---') {
    return { ok: false, error: '缺少 frontmatter 头（应以 --- 开头）' };
  }
  i += 1;
  const meta: Record<string, string> = {};
  let closed = false;
  for (; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '---') {
      closed = true;
      i += 1;
      break;
    }
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (m) meta[m[1]!] = m[2]!.trim();
  }
  if (!closed) return { ok: false, error: 'frontmatter 未闭合' };
  const content = lines.slice(i).join('\n').trim();

  const warnings: string[] = [];
  const command = meta.command ?? '';
  if (!SKILL_COMMAND_RE.test(command)) {
    return {
      ok: false,
      error: `command 缺失或非法（需 kebab-case 小写字母/数字/连字符，1-32 字符）：${command || '（空）'}`,
    };
  }
  let name = meta.name ?? '';
  if (!name) {
    name = (filename ?? '').replace(/\.md$/i, '').trim() || '未命名技能';
    warnings.push(`缺少 name，使用文件名「${name}」`);
  }
  const description = meta.description ?? '';
  if (!meta.description) warnings.push('缺少 description');

  return { ok: true, skill: { name, description, command, content }, warnings };
}

/** 序列化单文档。name/description 内的换行替换为空格，保证 parse(serialize(x)) 无条件成立。 */
export function serializeSkillMd(s: SkillMdFields): string {
  const single = (v: string) => v.replace(/\r?\n/g, ' ');
  return `---\nname: ${single(s.name)}\ndescription: ${single(s.description)}\ncommand: ${s.command}\n---\n${s.content}`;
}

/** 多文档串联（导出用）：文档间以独立 --- 块分隔。 */
export function serializeSkillsMd(list: SkillMdFields[]): string {
  return list.map(serializeSkillMd).join('\n---\n\n');
}

/** 候选段是否像「frontmatter 开头」：跳过前导空行后，首行 --- 且第二行匹配 key: value。 */
function looksLikeFrontmatterDoc(chunk: string): boolean {
  const lines = chunk.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i += 1;
  return lines[i]?.trim() === '---' && /^([A-Za-z][\w-]*)\s*:\s*/.test(lines[i + 1] ?? '');
}

/** 多文档解析（导入用）：先按文档间分隔符（\n---\n\n）拆开，再启发式合并不像 frontmatter
 *  开头的段（视为正文水平线），最后逐个 parseSkillMd。拆分前归一化 CRLF，避免 Windows
 *  行尾文件静默合并成单个坏文档。 */
export function parseSkillMdDocument(text: string, filename?: string): ParseSkillResult[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const SEP = '\n---\n\n';
  return normalized
    .split(SEP)
    .reduce<string[]>((acc, chunk) => {
      const prev = acc[acc.length - 1];
      if (prev !== undefined && !looksLikeFrontmatterDoc(chunk)) {
        acc[acc.length - 1] = prev + SEP + chunk;
      } else {
        acc.push(chunk);
      }
      return acc;
    }, [])
    .map((d) => parseSkillMd(d, filename));
}
