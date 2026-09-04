// components/skills/SkillsPage.tsx
// 技能管理二级页（spec §4）：列表（搜索/导入/导出/启停/删除）↔ 详情（仅查看）。无新建无编辑。
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Download, Search, Trash2, Upload } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useSkills, sendSkillsRequest } from '../../stores/skills';
import type { Skill, SkillSummary } from '../../shared/types';

/** 列表搜索（含停用全量）：name/command/description 子串，大小写不敏感 */
function filterAll(list: SkillSummary[], q: string): SkillSummary[] {
  const s = q.trim().toLowerCase();
  if (!s) return list;
  return list.filter(
    (x) =>
      x.name.toLowerCase().includes(s) ||
      x.command.toLowerCase().includes(s) ||
      x.description.toLowerCase().includes(s),
  );
}

/** SKILLS_IMPORT 响应 data（后台 SkillsImportResult 线格式） */
interface SkillsImportData {
  imported: number;
  overwritten: number;
  warnings: string[];
}

/** 面板聚合结果；kind 仅 'import' 时渲染计数行（导出/删除失败只显 warnings） */
interface ImportAggregate extends SkillsImportData {
  kind: 'import' | 'export';
}

export function SkillsPage({ onBack }: { onBack: () => void }) {
  const { list, refresh } = useSkills();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<ImportAggregate | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [detail, setDetail] = useState<Skill | null>(null);

  useEffect(() => { void refresh(); }, [refresh]);

  // 详情：SkillSummary 无 content，命中详情时单独拉全量
  useEffect(() => {
    setDetail(null);
    if (detailId == null) return;
    void (async () => {
      const resp = await sendSkillsRequest<{ ok: boolean; data?: { skill: Skill }; error?: string }>({
        type: 'SKILLS_GET',
        id: detailId,
      });
      if (resp.ok && resp.data) setDetail(resp.data.skill);
      else setDetailId(null); // 已被删等情况 → 回列表
    })();
  }, [detailId]);

  async function importFiles(files: FileList): Promise<void> {
    const agg: ImportAggregate = { kind: 'import', imported: 0, overwritten: 0, warnings: [] };
    for (const f of Array.from(files)) {
      let text: string;
      try {
        text = await f.text();
      } catch {
        agg.warnings.push(`${f.name}：读取失败`);
        continue;
      }
      const resp = await sendSkillsRequest<{ ok: boolean; data?: SkillsImportData; error?: string }>({
        type: 'SKILLS_IMPORT',
        text,
        filename: f.name,
      });
      if (resp.ok && resp.data) {
        agg.imported += resp.data.imported;
        agg.overwritten += resp.data.overwritten;
        agg.warnings.push(...resp.data.warnings);
      } else {
        agg.warnings.push(`${f.name}：${resp.error ?? '导入失败'}`);
      }
    }
    setResult(agg);
    await refresh();
  }

  async function exportMd(): Promise<void> {
    const resp = await sendSkillsRequest<{ ok: boolean; data?: { text: string; count: number }; error?: string }>({
      type: 'SKILLS_EXPORT',
    });
    if (!resp.ok || !resp.data) {
      setResult({ kind: 'export', imported: 0, overwritten: 0, warnings: [resp.error ?? '导出失败'] });
      return;
    }
    // 单条文件名用其 command；多条用日期
    const single = resp.data.count === 1 ? /^command: ([a-z0-9-]+)$/m.exec(resp.data.text)?.[1] : undefined;
    const name = single ? `${single}.md` : `skills-${new Date().toISOString().slice(0, 10)}.md`;
    const url = URL.createObjectURL(new Blob([resp.data.text], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function setEnabled(id: string, enabled: boolean): Promise<void> {
    await sendSkillsRequest({ type: 'SKILLS_SET_ENABLED', id, enabled });
    await refresh();
  }

  async function remove(id: string, name: string): Promise<void> {
    if (!window.confirm(`删除技能「${name}」？不可恢复。`)) return;
    try {
      await sendSkillsRequest({ type: 'SKILLS_DELETE', id });
    } catch (e) {
      // channel 断开等 reject：显式提示而非未处理 rejection
      setResult({
        kind: 'export',
        imported: 0,
        overwritten: 0,
        warnings: [`删除「${name}」失败：${e instanceof Error ? e.message : String(e)}`],
      });
    }
    await refresh();
  }

  // ---------- 详情页（仅查看）----------
  if (detailId != null) {
    return (
      <PageShell
        title={detail?.name ?? '技能详情'}
        eyebrow="SKILL"
        actions={
          <Button variant="ghost" className="btn--icon" aria-label="返回列表" onClick={() => setDetailId(null)}>
            <ChevronLeft size={16} />
          </Button>
        }
      >
        {detail && (
          <div className="skills-detail">
            <div className="skills-detail__head">
              <span className="mono slash-chip">/{detail.command}</span>
              <button
                type="button"
                role="switch"
                aria-checked={detail.enabled}
                aria-label={`${detail.enabled ? '禁用' : '启用'} ${detail.name}`}
                className={`switch${detail.enabled ? ' switch--on' : ''}`}
                onClick={() => {
                  void setEnabled(detail.id, !detail.enabled);
                  setDetail({ ...detail, enabled: !detail.enabled });
                }}
              >
                <span className="switch__thumb" aria-hidden />
              </button>
            </div>
            {detail.description && <div className="skills-detail__desc">{detail.description}</div>}
            <span className="token">CONTENT</span>
            <div className="well">{detail.content}</div>
            <div className="skills-detail__meta">更新于 {new Date(detail.updatedAt).toLocaleString()}</div>
          </div>
        )}
      </PageShell>
    );
  }

  // ---------- 列表页 ----------
  const visible = filterAll(list, query);

  return (
    <PageShell
      title="技能管理"
      eyebrow="SKILLS"
      actions={
        <>
          <Button variant="ghost" className="btn--icon" aria-label="导入技能" onClick={() => fileRef.current?.click()}>
            <Upload size={16} />
          </Button>
          <Button variant="ghost" className="btn--icon" aria-label="导出全部技能" onClick={() => void exportMd()}>
            <Download size={16} />
          </Button>
          <Button variant="ghost" className="btn--icon" aria-label="返回设置" onClick={onBack}>
            <ChevronLeft size={16} />
          </Button>
        </>
      }
    >
      {result && result.warnings.length > 0 && (
        <div className="scripts-warnline" role="status">
          {result.warnings.map((w, i) => (<div key={i}>{w}</div>))}
        </div>
      )}
      {result && result.kind === 'import' && (
        <div className="scripts-warnline" role="status">
          导入 {result.imported} 个，覆盖 {result.overwritten} 个
        </div>
      )}

      <div className="scripts-toolbar">
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={13} style={{ position: 'absolute', left: 8, top: 8, color: 'var(--ink-3)' }} aria-hidden />
          <Input
            aria-label="搜索技能"
            placeholder="搜索名称 / 命令 / 简述…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ paddingLeft: 26 }}
          />
        </div>
      </div>

      <div className="scripts-list">
        {visible.map((s) => (
          <div
            key={s.id}
            className={`scripts-card${s.enabled ? '' : ' scripts-card--off'}`}
            role="button"
            tabIndex={0}
            onClick={() => setDetailId(s.id)}
            onKeyDown={(e) => {
              if (e.currentTarget !== e.target) return; // 子元素（switch/删除钮）冒泡上来的按键不接管
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setDetailId(s.id);
              }
            }}
          >
            <div className="scripts-card__top">
              <span className="scripts-card__name">{s.name}</span>
              <button
                type="button"
                className="scripts-card__delbtn"
                aria-label={`删除 ${s.name}`}
                title="删除技能"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(s.id, s.name);
                }}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <Trash2 size={14} aria-hidden />
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={s.enabled}
                aria-label={`${s.enabled ? '禁用' : '启用'} ${s.name}`}
                className={`switch${s.enabled ? ' switch--on' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void setEnabled(s.id, !s.enabled);
                }}
              >
                <span className="switch__thumb" aria-hidden />
              </button>
            </div>
            <div className="scripts-card__meta">
              <span className="mono slash-chip">/{s.command}</span>
              <span className="scripts-card__match">{s.description}</span>
            </div>
          </div>
        ))}
        {visible.length === 0 && <div className="chat__empty">没有匹配的技能</div>}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".md,text/markdown"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length) void importFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </PageShell>
  );
}
