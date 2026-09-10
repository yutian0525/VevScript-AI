// tests/shared/skill-md.test.ts
// Skill .md 文件解析/序列化测试（spec §1.3）。

import { describe, it, expect } from 'vitest';
import { parseSkillMd, parseSkillMdDocument, serializeSkillMd, serializeSkillsMd } from '../../shared/skill-md';
// 打包资源照 tests/background/builtin-skills.test.ts 惯例用 ?raw 导入（不依赖测试进程 cwd），
// 直接对真实文件验证，防止文档格式漂移到解析失败。
import builtinMd from '../../public/skills/builtin.md?raw';

describe('parseSkillMd', () => {
  it('正常解析：frontmatter 三字段 + 正文', () => {
    const md = [
      '---',
      'name: 网页翻译',
      'description: 把当前页翻译成中文',
      'command: translate',
      '---',
      '第1行指令',
      '第2行指令',
    ].join('\n');
    const r = parseSkillMd(md, 'a.md');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.name).toBe('网页翻译');
      expect(r.skill.description).toBe('把当前页翻译成中文');
      expect(r.skill.command).toBe('translate');
      expect(r.skill.content).toBe('第1行指令\n第2行指令');
      expect(r.warnings).toEqual([]);
    }
  });

  it('frontmatter 前允许空行；正文首尾空行裁剪', () => {
    const md = '\n---\nname: A\ndescription: d\ncommand: a\n---\n\n正文\n\n';
    const r = parseSkillMd(md, 'a.md');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.skill.content).toBe('正文');
  });

  it('缺 command → 从 name 自动派生 + warning', () => {
    const r = parseSkillMd('---\nname: My Skill\n---\n正文', 'a.md');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.command).toBe('my-skill');
      expect(r.warnings.some((w) => w.includes('自动派生'))).toBe(true);
    }
  });

  it('command 格式非法 → 从 name 自动派生 + warning', () => {
    const r = parseSkillMd('---\nname: Web Translate\ncommand: Bad_Name!\n---\n正文', 'a.md');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.command).toBe('web-translate');
      expect(r.warnings.some((w) => w.includes('自动派生'))).toBe(true);
    }
  });

  it('缺 command 且 name 纯中文 → 从文件名兜底派生', () => {
    const r = parseSkillMd('---\nname: 网页翻译\n---\n正文', 'web-translate.md');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.skill.command).toBe('web-translate');
  });

  it('缺 command 且 name 纯中文、文件名也派生不出 → 拒绝', () => {
    const r = parseSkillMd('---\nname: 网页翻译\n---\n正文', '技能.md');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('command');
  });

  it('缺 name → 文件名兜底 + warning；缺 description → 空串 + warning', () => {
    const r = parseSkillMd('---\ncommand: a\n---\n正文', 'hello.md');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.name).toBe('hello');
      expect(r.skill.description).toBe('');
      expect(r.warnings).toHaveLength(2);
    }
  });

  it('无 frontmatter → 拒绝', () => {
    const r = parseSkillMd('只有正文没有头', 'a.md');
    expect(r.ok).toBe(false);
  });

  it('frontmatter 未闭合 → 拒绝', () => {
    const r = parseSkillMd('---\nname: A\ncommand: a\n正文没有闭合', 'a.md');
    expect(r.ok).toBe(false);
  });

  it('多余键忽略（license 等）', () => {
    const r = parseSkillMd('---\nname: A\ndescription: d\ncommand: a\nlicense: MIT\n---\n正文', 'a.md');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toEqual([]);
  });
});

describe('serializeSkillMd / serializeSkillsMd / parseSkillMdDocument', () => {
  it('序列化含三字段 + 正文', () => {
    const out = serializeSkillMd({ name: '网页翻译', description: '简述', command: 'translate', content: '指令' });
    expect(out).toBe('---\nname: 网页翻译\ndescription: 简述\ncommand: translate\n---\n指令');
  });

  it('parse(serialize(x)) 幂等', () => {
    const src = serializeSkillMd({ name: 'N', description: 'D', command: 'x', content: 'C\nC2' });
    const r = parseSkillMd(src, 'x.md');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.name).toBe('N');
      expect(r.skill.content).toBe('C\nC2');
      expect(r.warnings).toHaveLength(0);
    }
  });

  it('serializeSkillsMd 串联 → parseSkillMdDocument 逐个解析', () => {
    const docs = serializeSkillsMd([
      { name: 'A', description: '', command: 'a', content: 'CA' },
      { name: 'B', description: '', command: 'b', content: 'CB' },
    ]);
    const parsed = parseSkillMdDocument(docs);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.ok && parsed[0]!.skill.command).toBe('a');
    expect(parsed[1]!.ok && parsed[1]!.skill.command).toBe('b');
  });

  it('CRLF 行尾的多文档串联仍正确拆分（不静默合并）', () => {
    const crlf = serializeSkillsMd([
      { name: 'A', description: '', command: 'a', content: 'CA' },
      { name: 'B', description: '', command: 'b', content: 'CB' },
    ]).replace(/\n/g, '\r\n');
    const parsed = parseSkillMdDocument(crlf);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.ok && parsed[0]!.skill.command).toBe('a');
    expect(parsed[1]!.ok && parsed[1]!.skill.command).toBe('b');
  });

  it('正文含 --- 水平线的单文档不被误拆', () => {
    const src = serializeSkillMd({ name: 'A', description: 'd', command: 'a', content: 'step1\n\n---\n\nstep2' });
    const parsed = parseSkillMdDocument(src);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.ok).toBe(true);
    if (parsed[0]!.ok) expect(parsed[0]!.skill.content).toBe('step1\n\n---\n\nstep2');
  });

  it('无 frontmatter 的坏文档并入前段时留下 absorbed warning', () => {
    const docs = [
      serializeSkillMd({ name: 'A', description: 'd', command: 'a', content: 'CA' }),
      '没有 frontmatter 的坏文档',
      serializeSkillMd({ name: 'B', description: 'd', command: 'b', content: 'CB' }),
    ].join('\n---\n\n');
    const parsed = parseSkillMdDocument(docs);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.ok).toBe(true);
    expect(parsed[1]!.ok).toBe(true);
    if (parsed[0]!.ok) {
      expect(parsed[0]!.skill.content).toContain('没有 frontmatter 的坏文档');
      expect(parsed[0]!.warnings.some((w) => w.includes('已并入'))).toBe(true);
    }
  });

  it('被并段出现在第二个文档后时 warning 落在最后一个文档上', () => {
    const docs = [
      serializeSkillMd({ name: 'A', description: 'd', command: 'a', content: 'CA' }),
      serializeSkillMd({ name: 'B', description: 'd', command: 'b', content: 'CB' }),
      '没有 frontmatter 的坏文档',
    ].join('\n---\n\n');
    const parsed = parseSkillMdDocument(docs);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]!.ok).toBe(true);
    if (parsed[1]!.ok) {
      expect(parsed[1]!.skill.content).toContain('没有 frontmatter 的坏文档');
      expect(parsed[1]!.warnings.some((w) => w.includes('已并入'))).toBe(true);
    }
    if (parsed[0]!.ok) expect(parsed[0]!.warnings).toHaveLength(0);
  });

  it('serializeSkillMd 对 name/description 换行做防御（round-trip 无条件成立）', () => {
    const out = serializeSkillMd({ name: '多\n行名', description: 'desc\nription', command: 'x', content: 'C' });
    const r = parseSkillMd(out, 'x.md');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.name).toBe('多 行名');
      expect(r.skill.description).toBe('desc ription');
      expect(r.warnings).toHaveLength(0);
    }
  });
});

describe('内置技能资源 builtin.md', () => {
  const docs = parseSkillMdDocument(builtinMd);

  it('三篇文档全部解析成功，无坏文档', () => {
    expect(docs).toHaveLength(3);
    expect(docs.every((d) => d.ok)).toBe(true);
  });

  it('command 唯一且不含 page-script（该技能已随 run_page_script 拆除）', () => {
    const cmds = docs.map((d) => (d.ok ? d.skill.command : ''));
    expect(new Set(cmds).size).toBe(cmds.length);
    expect(cmds).not.toContain('page-script');
  });
});
