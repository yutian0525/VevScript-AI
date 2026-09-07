// components/skills/SkillsPage.tsx
// 技能管理二级页（spec §4）：列表（搜索/导入/导出/启停/删除）↔ 详情（仅查看）。无新建无编辑。
import { useEffect, useRef, useState } from 'react';
import { Download, Search, Trash2, Upload } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Tooltip } from '../ui/Tooltip';
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
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

  async function exportMd(ids?: string[]): Promise<void> {
    const resp = await sendSkillsRequest<{ ok: boolean; data?: { text: string; count: number }; error?: string }>({
      type: 'SKILLS_EXPORT',
      ids,
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

  function toggleSelected(id: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    await refresh();
  }

  /** 内置技能：不可删除（后台拒删 + UI 不渲染删除钮），只可停用。 */
  const deleteSkillEntry = (s: SkillSummary): void => {
    if (s.builtin) {
      setResult({
        kind: 'export',
        imported: 0,
        overwritten: 0,
        warnings: [`「${s.name}」是内置技能，不可删除，如不需要可停用`],
      });
      return;
    }
    void remove(s.id, s.name);
  };

  // ---------- 详情页（仅查看）----------
  if (detailId != null) {
    return (
      <PageShell
        title={detail?.name ?? '技能详情'}
        eyebrow="SKILL"
        onBack={() => setDetailId(null)}
        backLabel="返回列表"
      >
        {detail && (
          <div className="skills-detail">
            <div className="skills-detail__head">
              <span className="mono slash-chip">/{detail.command}</span>
              {detail.builtin && <span className="token">内置</span>}
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
  // 勾选导出：只导当前列表里仍存在的勾选项（refresh 后已消失的 id 自动失效）
  const exportIds = selectedIds.size > 0
    ? list.filter((s) => selectedIds.has(s.id)).map((s) => s.id)
    : undefined;
  const exportLabel = exportIds
    ? `导出选中的 ${exportIds.length} 个技能`
    : '导出全部技能';

  return (
    <PageShell
      title="技能管理"
      eyebrow="SKILLS"
      onBack={onBack}
      backLabel="返回设置"
      actions={
        <>
          <Tooltip label="导入技能">
            <Button variant="ghost" className="btn--icon" aria-label="导入技能" onClick={() => fileRef.current?.click()}>
              <Upload size={16} />
            </Button>
          </Tooltip>
          <Tooltip label={exportLabel}>
            <Button
              variant="ghost"
              className="btn--icon"
              aria-label={exportLabel}
              onClick={() => void exportMd(exportIds)}
            >
              <Download size={16} />
            </Button>
          </Tooltip>
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
              <input
                type="checkbox"
                className="skills-card__check"
                aria-label={`选择 ${s.name}`}
                checked={selectedIds.has(s.id)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()} // 键盘空格勾选不触发卡片进详情
                onChange={() => toggleSelected(s.id)}
              />
              <span className="scripts-card__name">{s.name}</span>
              {s.builtin && (
                <Tooltip label="内置技能：不可删除，可停用">
                  <span className="token">内置</span>
                </Tooltip>
              )}
              {!s.builtin && (
                <Tooltip label="删除技能">
                  <button
                    type="button"
                    className="scripts-card__delbtn"
                    aria-label={`删除 ${s.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteSkillEntry(s);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <Trash2 size={14} aria-hidden />
                  </button>
                </Tooltip>
              )}
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
