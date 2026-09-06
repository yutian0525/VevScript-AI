// entrypoints/script-detail/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { DetailApp } from '../../components/detail/DetailApp';
import '../sidepanel/styles.css';

const params = new URLSearchParams(location.search);
const id = params.get('id') ?? '';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {id ? <DetailApp id={id} /> : <div className="detail detail--empty">缺少脚本 id 参数</div>}
  </React.StrictMode>,
);
