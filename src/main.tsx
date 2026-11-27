import './styles/app.css';
import './styles/review.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { applyAccent, applyTheme, readAccent, readTheme } from './app/theme';

applyTheme(readTheme());
applyAccent(readAccent());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
