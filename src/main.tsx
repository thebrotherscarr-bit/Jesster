import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// When an installed PWA is updated, the new service worker can activate while
// the old page is still running. Reload once so the user gets the new assets.
// A first-ever install has no controller, so it must not trigger a reload.
if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
}

createRoot(document.getElementById('root')!).render(<App />);
