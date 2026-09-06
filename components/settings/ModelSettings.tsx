// components/settings/ModelSettings.tsx
// 模型设置（设置二级页）：AI 服务表单（原 SettingsView 内容平移，加 onBack 返回钮）。
import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { getSettings, saveSettings, type Settings } from '../../storage/settings';
import { testConnection, type ConnectionTestResult } from '../../agent/provider/connection-test';
import { resolveContextWindow } from '../../agent/model-windows';

/** 解析额外参数 JSON：空串→undefined；非对象或非法→抛错（供保存时拦截）。 */
function parseExtraBody(text: string): Record<string, unknown> | undefined {
  const t = text.trim();
  if (!t) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    throw new Error('不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('必须是 JSON 对象，如 {"enable_thinking": true}');
  }
  return parsed as Record<string, unknown>;
}

export function ModelSettings({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [extraText, setExtraText] = useState('');
  const [extraError, setExtraError] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then((s) => {
      setSettings(s);
      setExtraText(s.provider.extraBody ? JSON.stringify(s.provider.extraBody, null, 2) : '');
    });
  }, []);

  const back = (
    <Button variant="ghost" onClick={onBack} aria-label="返回">
      <ArrowLeft size={14} />
    </Button>
  );

  if (!settings) {
    return (
      <PageShell title="模型设置" eyebrow="MODEL" actions={back}>
        <div className="hint">加载中…</div>
      </PageShell>
    );
  }

  const setProvider = (patch: Partial<Settings['provider']>) =>
    setSettings({ ...settings, provider: { ...settings.provider, ...patch } });

  /** 校验额外参数文本；非法则设错误并返回 null（拦截保存）。合法返回带 extraBody 的 provider。 */
  const resolveProvider = (): Settings['provider'] | null => {
    try {
      const extraBody = parseExtraBody(extraText);
      setExtraError(null);
      return { ...settings.provider, extraBody };
    } catch (e) {
      setExtraError(e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  const handleSave = async () => {
    const provider = resolveProvider();
    if (!provider) return;
    setSettings({ ...settings, provider });
    await saveSettings({ provider, agent: settings.agent });
    setTestResult(null);
  };

  const handleTest = async () => {
    const provider = resolveProvider();
    if (!provider) return;
    setSettings({ ...settings, provider });
    setTesting(true);
    setTestResult(null);
    await saveSettings({ provider }); // 测试的就是当前表单值
    const r = await testConnection(provider);
    setTestResult(r);
    setTesting(false);
  };

  return (
    <PageShell title="模型设置" eyebrow="MODEL" actions={back}>
      <section className="section">
        <h2 className="section__title">AI 服务（OpenAI 兼容）</h2>
        <div className="field">
          <label className="field-label">Base URL</label>
          <Input
            value={settings.provider.baseUrl}
            onChange={(e) => setProvider({ baseUrl: e.target.value })}
            placeholder="https://api.deepseek.com/v1"
          />
        </div>
        <div className="field">
          <label className="field-label">API Key</label>
          <Input
            type="password"
            value={settings.provider.apiKey}
            onChange={(e) => setProvider({ apiKey: e.target.value })}
            placeholder="sk-…"
          />
        </div>
        <div className="field">
          <label className="field-label">模型</label>
          <Input
            value={settings.provider.model}
            onChange={(e) => setProvider({ model: e.target.value })}
            placeholder="deepseek-chat"
          />
        </div>
        <div className="field">
          <label className="field-label">上下文窗口（token，选填）</label>
          <Input
            type="number"
            value={settings.provider.contextWindow ?? ''}
            onChange={(e) => {
              const v = e.target.value.trim();
              setProvider({ contextWindow: v === '' ? undefined : Number(v) });
            }}
            placeholder={String(resolveContextWindow(settings.provider.model))}
          />
          <span className="hint">留空则按模型名自动推断。用于上下文用量标识与压缩阈值。</span>
        </div>
        <div className="field">
          <label className="field-label">额外请求参数（JSON，选填）</label>
          <textarea
            className="textarea mono-input"
            value={extraText}
            onChange={(e) => { setExtraText(e.target.value); setExtraError(null); }}
            placeholder={'{\n  "enable_thinking": true\n}'}
            spellCheck={false}
            rows={4}
          />
          {extraError ? (
            <span className="status-text status-text--err">参数无效：{extraError}</span>
          ) : (
            <span className="hint">合并进请求体，用于开启各网关的思考等开关（如 enable_thinking / reasoning_effort）。核心字段受保护不被覆盖。</span>
          )}
        </div>
        <div className="field">
          <label className="field-label">单轮回复上限（token，0 = 不下发）</label>
          <Input
            type="number"
            min={0}
            value={settings.agent.maxTokens}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSettings({ ...settings, agent: { ...settings.agent, maxTokens: Number.isFinite(v) ? Math.max(0, v) : 0 } });
            }}
          />
          <span className="hint">下发为 max_tokens。太小会让长回复/长工具参数被截断；置 0 则不下发该字段（走服务端默认）。</span>
        </div>
        <div className="field">
          <label className="field-label">超时时间（秒，0 = 不限时）</label>
          <Input
            type="number"
            min={0}
            value={settings.agent.llmTimeoutSec}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSettings({ ...settings, agent: { ...settings.agent, llmTimeoutSec: Number.isFinite(v) ? Math.max(0, v) : 0 } });
            }}
          />
          <span className="hint">静默窗口：连接后或流式输出中，超过该时长未收到任何数据即判定挂死并中止（0 = 关闭超时保护）。</span>
        </div>
        <div className="field">
          <label className="field-label">失败重试次数（0 = 不重试）</label>
          <Input
            type="number"
            min={0}
            value={settings.agent.llmMaxRetries}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSettings({ ...settings, agent: { ...settings.agent, llmMaxRetries: Number.isFinite(v) ? Math.max(0, v) : 0 } });
            }}
          />
          <span className="hint">网络错误、HTTP 429/5xx、超时时自动重试；已开始输出内容后失败不重试（避免回复重复）。429/5xx 指数退避。</span>
        </div>
      </section>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="primary" onClick={handleSave}>
          保存
        </Button>
        <Button onClick={handleTest} disabled={testing}>
          {testing ? '测试中…' : '测试连接'}
        </Button>
        {testResult && (
          <span className={`status-text ${testResult.ok ? 'status-text--ok' : 'status-text--err'}`}>
            {testResult.ok ? `连接成功：${testResult.data}` : testResult.error}
          </span>
        )}
      </div>
    </PageShell>
  );
}
