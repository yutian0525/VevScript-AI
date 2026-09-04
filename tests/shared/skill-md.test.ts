// tests/shared/skill-md.test.ts
// Skill .md 文件解析/序列化测试（spec §1.3）。

import { describe, it, expect } from 'vitest';
import { parseSkillMd, parseSkillMdDocument, serializeSkillMd, serializeSkillsMd } from '../../shared/skill-md';

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

  it('缺 command → 拒绝', () => {
    const r = parseSkillMd('---\nname: A\n---\n正文', 'a.md');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('command');
  });

  it('command 格式非法 → 拒绝（kebab-case）', () => {
    const r = parseSkillMd('---\nname: A\ncommand: Bad_Name!\n---\n正文', 'a.md');
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
});
