import { useEffect, useState } from 'react';

export type Route = 'home' | 'docs';

function parse(hash: string): Route {
  return hash.replace(/^#\/?/, '').split('?')[0] === 'docs' ? 'docs' : 'home';
}

/** 极简 hash 路由。用 hash 而非 history：产物丢到任意静态托管（含 GitHub Pages 子路径）
 *  都不需要服务端 rewrite，为两个页面引一个路由库不值当。 */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === 'undefined' ? 'home' : parse(window.location.hash),
  );

  useEffect(() => {
    const onHash = () => {
      setRoute(parse(window.location.hash));
      window.scrollTo({ top: 0, behavior: 'auto' });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return route;
}

export const REPO = 'https://github.com/yutian0525/VevScript-AI';
/** GitHub Release 下载页（「立即下载」按钮跳向此处） */
export const RELEASES = `${REPO}/releases`;
/** 官网 */
export const SITE = 'https://vevscript.yutkit.com';
