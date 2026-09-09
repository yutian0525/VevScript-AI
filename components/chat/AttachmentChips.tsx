// components/chat/AttachmentChips.tsx
// 附件 tag 展示：图片显缩略图、文本显文件图标 + 名字。可编辑态（composer）带移除钮。
import { FileText, X } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import type { ChatAttachment } from '../../shared/types';
import { formatBytes } from './attachments';

export function AttachmentChips({
  items,
  onRemove,
}: {
  items: ChatAttachment[];
  /** 提供则渲染移除钮（可编辑态：输入框暂存区）。缺省 = 只读（消息气泡内）。 */
  onRemove?: (index: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="attach-chips">
      {items.map((a, i) => (
        <Tooltip key={i} label={`${a.name}${a.size ? ` · ${formatBytes(a.size)}` : ''}`}>
          <div className={`attach-chip attach-chip--${a.kind}`}>
            {a.kind === 'image' && a.dataUrl ? (
              <img className="attach-chip__thumb" src={a.dataUrl} alt={a.name} />
            ) : (
              <FileText size={13} className="attach-chip__icon" />
            )}
            <span className="attach-chip__name mono">{a.name}</span>
            {onRemove && (
              <button
                type="button"
                className="attach-chip__rm"
                aria-label={`移除附件 ${a.name}`}
                onClick={() => onRemove(i)}
              >
                <X size={12} />
              </button>
            )}
          </div>
        </Tooltip>
      ))}
    </div>
  );
}
