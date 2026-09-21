// entrypoints/conv-debug/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConvDebugApp } from '../../components/convdebug/ConvDebugApp';
import '../sidepanel/styles.css';

const params = new URLSearchParams(location.search);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConvDebugApp initialConvId={params.get('convId') ?? ''} />
  </React.StrictMode>,
);
