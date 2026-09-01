// shared/match-pattern.ts
// Chrome match pattern 校验与匹配（纯函数，spec §6.2）。运行态跟踪与 pattern 校验共用。

const MATCH_RE = /^(\*|https?|file|ftp|ws|wss):\/\/(\*|(?:\*\.)?[^/*:'"()]*)\/(.*)$/;

const ALL_URL_SCHEMES = 'https?|file|ftp|wss?';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isValidMatchPattern(pattern: string): boolean {
  if (pattern === '<all_urls>') return true;
  return MATCH_RE.test(pattern);
}

/** 非法 pattern 抛 Error；调用方可用 isValidMatchPattern 预检或 catch。 */
export function matchPatternToRegExp(pattern: string): RegExp {
  if (pattern === '<all_urls>') return new RegExp(`^(${ALL_URL_SCHEMES}):\\/\\/`);
  const m = MATCH_RE.exec(pattern);
  if (!m) throw new Error(`非法 match pattern：${pattern}`);
  // MATCH_RE 的三个捕获组必然参与匹配，默认值仅为满足 noUncheckedIndexedAccess
  const [, scheme = '', host = '', path = ''] = m;
  const schemeRe = scheme === '*' ? 'https?' : scheme;
  let hostRe: string;
  if (host === '*') hostRe = '[^/]+';
  else if (host.startsWith('*.')) hostRe = `([^/]+\\.)?${escapeRe(host.slice(2))}`;
  else hostRe = escapeRe(host);
  const pathRe = escapeRe(path).replace(/\\\*/g, '.*');
  return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`);
}

export function matchUrl(patterns: string[], url: string): boolean {
  if (!url) return false;
  return patterns.some((p) => {
    try {
      return matchPatternToRegExp(p).test(url);
    } catch {
      return false;
    }
  });
}
