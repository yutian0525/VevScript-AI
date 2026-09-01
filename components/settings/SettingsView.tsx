// components/settings/SettingsView.tsx
import { useEffect, useState, type CSSProperties } from 'react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { getSettings, saveSettings, type Settings } from '../../storage/settings';
import { testConnection, type ConnectionTestResult } from '../../agent/provider/connection-test';

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  marginBottom: 14,
};

export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  useEffect(() => {
    getSettings().then(setSettings);
  }, []);

  if (!settings) {
    return (
      <PageShell title="设置">
        <div>加载中…</div>
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
    <PageShell title="设置">
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 12px' }}>AI 服务（OpenAI 兼容）</h2>
        <div style={fieldStyle}>
          <label>Base URL</label>
          <Input
            value={settings.provider.baseUrl}
            onChange={(e) => setProvider({ baseUrl: e.target.value })}
            placeholder="https://api.deepseek.com/v1"
          />
        </div>
        <div style={fieldStyle}>
          <label>API Key</label>
          <Input
            type="password"
            value={settings.provider.apiKey}
            onChange={(e) => setProvider({ apiKey: e.target.value })}
            placeholder="sk-…"
          />
        </div>
        <div style={fieldStyle}>
          <label>模型</label>
          <Input
            value={settings.provider.model}
            onChange={(e) => setProvider({ model: e.target.value })}
            placeholder="deepseek-chat"
          />
        </div>
      </section>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button variant="primary" onClick={handleSave}>
          保存
        </Button>
        <Button onClick={handleTest} disabled={testing}>
          {testing ? '测试中…' : '测试连接'}
        </Button>
        {testResult && (
          <span style={{ fontSize: 12, color: testResult.ok ? '#16a34a' : '#dc2626' }}>
            {testResult.ok ? `连接成功：${testResult.data}` : testResult.error}
          </span>
        )}
      </div>
    </PageShell>
  );
}
