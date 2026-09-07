// background/gm-download.ts
// GM_download 的 chrome.downloads 封装（spec §5.3）。onload/onerror 保证；onprogress 首版缺省。
// resolve 于下载终态：state=complete → ok；state=interrupted → error。门控在 gm-api.doDownload。

export interface DownloadDetails {
  url?: string;
  name?: string;
  headers?: Record<string, string>;
  saveAs?: boolean;
  timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 分钟终态兜底

interface DownloadDelta { id: number; state?: { current?: string }; error?: { current?: string } }
type DownloadsApi = {
  download(opts: Record<string, unknown>): Promise<number>;
  onChanged: {
    addListener(cb: (d: DownloadDelta) => void): void;
    removeListener(cb: (d: DownloadDelta) => void): void;
  };
};

function api(): DownloadsApi {
  const d = (browser as unknown as { downloads?: DownloadsApi }).downloads;
  if (!d) throw new Error('downloads API 不可用（需 manifest downloads 权限）');
  return d;
}

/** 触发下载，Promise resolve 于终态。listener 先挂再 download，避免漏接早到的 onChanged。 */
export function runDownload(details: DownloadDetails): Promise<{ ok: true } | { ok: false; error: string }> {
  const d = api();
  let id: number | undefined;
  const headers = details.headers
    ? Object.entries(details.headers).map(([name, value]) => ({ name, value }))
    : undefined;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const onChanged = (delta: DownloadDelta): void => {
      if (id === undefined || delta.id !== id) return;
      const state = delta.state?.current;
      if (state === 'complete') finish({ ok: true });
      else if (state === 'interrupted') finish({ ok: false, error: delta.error?.current ?? 'interrupted' });
    };
    const finish = (r: { ok: true } | { ok: false; error: string }): void => {
      clearTimeout(timer);
      d.onChanged.removeListener(onChanged);
      resolve(r);
    };
    d.onChanged.addListener(onChanged);
    timer = setTimeout(
      () => finish({ ok: false, error: `下载超时（${details.timeout ?? DEFAULT_TIMEOUT_MS}ms 未达终态）` }),
      details.timeout ?? DEFAULT_TIMEOUT_MS,
    );
    const opts: Record<string, unknown> = { url: details.url, saveAs: !!details.saveAs };
    if (details.name) opts.filename = details.name;
    if (headers) opts.headers = headers;
    d.download(opts).then((got) => { id = got; }, (e) => {
      finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });
  });
}
