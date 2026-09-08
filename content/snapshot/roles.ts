// content/snapshot/roles.ts
// a11y role/name/state 计算（设计 §5）。简化的 ARIA 映射，覆盖常见可交互元素。

import { isHidden, isSkipTag } from './visibility';

/** 归一化：先 trim 后折叠空白再截断。name=100、description=200。 */
function normalize(s: string, max: number): string {
  return s.trim().replace(/\s+/g, ' ').slice(0, max);
}

export function computeRole(el: Element): string {
  const explicit = el.getAttribute('role')?.trim();
  if (explicit) return explicit.split(/\s+/)[0]!;

  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'button': return 'button';
    case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
    case 'select': return 'combobox';
    case 'option': return 'option';
    case 'textarea': return 'textbox';
    case 'input': {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'hidden') return 'generic';
      return 'textbox';
    }
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
    case 'img': return 'img';
    case 'iframe': case 'frame': return 'Iframe';
    case 'nav': return 'navigation';
    case 'ul': case 'ol': return 'list';
    case 'li': return 'listitem';
    default: return 'generic';
  }
}

// name-from-content：这些角色的可访问名可从其（可见）后代文本推导。
const NAME_FROM_CONTENT = new Set([
  'button', 'link', 'heading', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch',
]);

/** 聚合可见后代文本；跳过 isHidden 的子树。 */
export function visibleText(el: Element): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) out += node.textContent ?? '';
    else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      if (!isHidden(child)) out += visibleText(child);
    }
  }
  return out;
}

export function computeName(el: Element): string {
  const trunc = (s: string) => normalize(s, 100);

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return trunc(ariaLabel);

  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const ref = el.ownerDocument.getElementById(labelledby);
    if (ref?.textContent) return trunc(ref.textContent);
  }

  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    // <label for="id"> 关联 或 包裹式 <label><input></label>
    if (el.id) {
      const forLabel = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (forLabel?.textContent && forLabel.textContent.trim()) return trunc(forLabel.textContent);
    }
    const wrapLabel = el.closest('label');
    if (wrapLabel?.textContent && wrapLabel.textContent.trim()) return trunc(wrapLabel.textContent);
    const ph = el.getAttribute('placeholder');
    if (ph) return trunc(ph);
  }
  if (tag === 'img') {
    const alt = el.getAttribute('alt');
    if (alt) return trunc(alt);
  }

  const role = computeRole(el);
  if (NAME_FROM_CONTENT.has(role)) return trunc(visibleText(el));
  return '';
}

export function computeStates(el: Element): string[] {
  const states: string[] = [];
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') states.push('disabled');
  if ((el as HTMLInputElement).checked || el.getAttribute('aria-checked') === 'true') states.push('checked');
  if (el.getAttribute('aria-expanded') === 'true') states.push('expanded');
  const role = computeRole(el);
  if (role === 'tab' || role === 'option') states.push('selectable');
  if (el.getAttribute('aria-selected') === 'true' || (el as HTMLOptionElement).selected) states.push('selected');
  return states;
}

// 这些角色才聚合隐藏后代文本为 description（其余角色不聚合，避免噪声）。
// 不含 generic：真实页面几乎每个 div 都是 generic，给它做 collectHiddenText 会 O(N·300) 遍历，
// 且一个隐藏子树的文本会被每一层 generic 祖先各自重复聚合，导致本该折叠的布局 div 冒出重复描述。
const DESC_ROLES = new Set(['link', 'button', 'tab']);

/** 聚合 el 后代中「隐藏」的文本；带节点/字数预算，跳过 script/style。 */
export function collectHiddenText(el: Element): string {
  const parts: string[] = [];
  let visited = 0;
  let chars = 0;
  const walk = (node: Element, insideHidden: boolean) => {
    if (visited >= 300 || chars >= 200) return;
    // 必须提前返回：否则 isHidden(script/style)=true 会把脚本/样式源码当隐藏文本收集进 description
    if (isSkipTag(node)) return;
    const hidden = insideHidden || isHidden(node);
    for (const child of Array.from(node.childNodes)) {
      if (visited >= 300 || chars >= 200) break;
      if (child.nodeType === Node.TEXT_NODE) {
        if (hidden) {
          const t = (child.textContent ?? '').trim();
          if (t) { parts.push(t); chars += t.length; }
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        visited += 1;
        walk(child as Element, hidden);
      }
    }
  };
  walk(el, false);
  return normalize(parts.join(' '), 200);
}

export function computeDescription(el: Element): string {
  const describedby = el.getAttribute('aria-describedby');
  if (describedby) {
    const ref = el.ownerDocument.getElementById(describedby);
    if (ref?.textContent?.trim()) return normalize(ref.textContent, 200);
  }
  const ariaDesc = el.getAttribute('aria-description');
  if (ariaDesc?.trim()) return normalize(ariaDesc, 200);
  if (!DESC_ROLES.has(computeRole(el))) return '';
  return collectHiddenText(el);
}

export interface NodeExtras { url?: string; haspopup?: string; autocomplete?: string }

export function computeExtras(el: Element): NodeExtras {
  const extras: NodeExtras = {};
  const role = computeRole(el);
  if (role === 'link') {
    const href = el.getAttribute('href');
    if (href) { try { extras.url = new URL(href, el.ownerDocument.baseURI).href; } catch { extras.url = href; } }
  }
  const hp = el.getAttribute('aria-haspopup');
  if (hp && hp !== 'false') extras.haspopup = hp;
  const ac = el.getAttribute('autocomplete') || el.getAttribute('aria-autocomplete');
  if (ac) extras.autocomplete = ac;
  return extras;
}
