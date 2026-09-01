import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return <main>Digital Twin Workbench</main>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
