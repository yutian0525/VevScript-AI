// background/gm-cookie.ts
// GM_cookie.list/set/delete 的 chrome.cookies 薄封装（spec §5.2）。
// 门控（@connect + 确认卡）在 background/gm-api.ts 的 doCookie——本模块只做 API 透传。

export interface CookieDetails {
  url?: string;
  domain?: string;
  name?: string;
  path?: string;
  value?: string;
  expirationDate?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'no_restriction' | 'lax' | 'strict';
}

type CookiesApi = {
  getAll(d: Record<string, unknown>): Promise<unknown[]>;
  set(d: Record<string, unknown>): Promise<unknown>;
  remove(d: Record<string, unknown>): Promise<unknown>;
};

function api(): CookiesApi {
  const c = (browser as unknown as { cookies?: CookiesApi }).cookies;
  if (!c) throw new Error('cookies API 不可用（需 manifest cookies 权限）');
  return c;
}

/** 门控用的目标 URL：url 优先，否则由 domain 构造 https（去前导点）。 */
export function cookieTargetUrl(d: CookieDetails): string {
  if (d.url) return d.url;
  if (d.domain) return `https://${d.domain.replace(/^\./, '')}/`;
  return '';
}

export async function listCookies(d: CookieDetails): Promise<unknown[]> {
  const query: Record<string, unknown> = {};
  if (d.url) query.url = d.url;
  if (d.domain) query.domain = d.domain;
  if (d.name) query.name = d.name;
  if (d.path) query.path = d.path;
  return api().getAll(query);
}

export async function setCookie(d: CookieDetails): Promise<void> {
  const set: Record<string, unknown> = { url: cookieTargetUrl(d), name: d.name, value: d.value };
  if (d.path) set.path = d.path;
  if (d.expirationDate) set.expirationDate = d.expirationDate;
  if (d.httpOnly != null) set.httpOnly = d.httpOnly;
  if (d.secure != null) set.secure = d.secure;
  if (d.sameSite) set.sameSite = d.sameSite;
  await api().set(set);
}

export async function deleteCookie(d: CookieDetails): Promise<void> {
  await api().remove({ url: cookieTargetUrl(d), name: d.name });
}
