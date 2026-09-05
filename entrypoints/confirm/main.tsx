// entrypoints/confirm/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfirmHubApp } from '../../components/confirm/ConfirmHubApp';
import '../sidepanel/styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfirmHubApp />
  </React.StrictMode>,
);
