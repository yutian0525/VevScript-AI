// components/settings/SettingsView.tsx
import { useEffect, useState } from 'react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { getSettings, saveSettings, type Settings } from '../../storage/settings';
import { testConnection, type ConnectionTestResult } from '../../agent/provider/connection-test';

export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  useEffect(() => {
    getSettings().then(setSettings);
  }, []);

  if (!settings) {
    return (
      <PageShell title="设置" eyebrow="CONFIG">
        <div className="hint">加载中…</div>
      </PageShell>
    );
  }

  const setProvider = (patch: Partial<Settings['provider']>) =>
    setSettings({ ...settings, provider: { ...settings.provider, ...patch } });

  const handleSave = async () => {
    await saveSettings({ provider: settings.provider, agent: settings.agent });
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    await saveSettings({ provider: settings.provider }); // 测试的就是当前表单值
    const r = await testConnection(settings.provider);
    setTestResult(r);
    setTesting(false);
  };

  return (
    <PageShell title="设置" eyebrow="CONFIG">
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
