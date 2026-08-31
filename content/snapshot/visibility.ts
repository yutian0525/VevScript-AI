// content/snapshot/visibility.ts
// 隐藏节点过滤（设计 §5）。
// 注：0 尺寸过滤（getBoundingClientRect）作为真实浏览器增强，jsdom 恒返回 0 故不在此判定，
// 交给真实运行时；单测只覆盖 style/属性/标签维度。
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD']);

export function isHidden(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.hasAttribute('hidden')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;

  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style) {
    if (style.display === 'none') return true;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  }
  return false;
}
