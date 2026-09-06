// entrypoints/popup/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { PopupApp } from '../../components/popup/PopupApp';
import '../sidepanel/styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PopupApp />
  </React.StrictMode>,
);
