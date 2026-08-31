// content/snapshot/roles.ts
// a11y role/name/state 计算（设计 §5）。简化的 ARIA 映射，覆盖常见可交互元素。

const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab', 'switch']);

export function isInteractive(role: string): boolean {
  return INTERACTIVE_ROLES.has(role);
}

export function computeRole(el: Element): string {
  const explicit = el.getAttribute('role')?.trim();
  if (explicit) return explicit.split(/\s+/)[0]!;

  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'button': return 'button';
    case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
    case 'select': return 'combobox';
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
    case 'nav': return 'navigation';
    case 'ul': case 'ol': return 'list';
    case 'li': return 'listitem';
    default: return 'generic';
  }
}

export function computeName(el: Element): string {
  const trunc = (s: string) => s.trim().replace(/\s+/g, ' ').slice(0, 100);

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

  const text = el.textContent ?? '';
  return trunc(text);
}

export function computeStates(el: Element): string[] {
  const states: string[] = [];
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') states.push('disabled');
  if ((el as HTMLInputElement).checked || el.getAttribute('aria-checked') === 'true') states.push('checked');
  if (el.getAttribute('aria-expanded') === 'true') states.push('expanded');
  if (el.getAttribute('aria-selected') === 'true') states.push('selected');
  return states;
}
