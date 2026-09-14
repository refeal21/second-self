/** Offline real-App harness; only the injected synthetic DTO adapter is reachable. */
import { createRoot } from 'react-dom/client';
import { App } from '../src/App.js';
import { createDemoDesktopAdapter } from '../src/desktop-adapter.js';
import type { PresalesAdapter, V3Project, V3QueueSnapshot } from '../src/presales/adapter.js';
import { prepareV3Delivery, type V3DeliverySnapshot } from '../../worker/src/presales/delivery.js';

declare global {
  interface Window {
    acceptance: { project: V3Project; queue: V3QueueSnapshot };
    acceptanceCalls: Array<{ name: string; input: unknown }>;
  }
}
const state = window.acceptance;
const calls = window.acceptanceCalls = [];
const demo = createDemoDesktopAdapter();
const adapter = {
  ...demo, mode: 'tauri' as const,
  loadInitialState: async () => ({ ...demo.initialState, projects: [] }),
  listProjects: async () => [],
  // App auto-connect is intentionally fulfilled locally; no native adapter exists.
  connectAccount: async () => { calls.push({ name: 'syntheticAccount', input: null }); return demo.initialState.account; },
};

function syntheticPreview(slideId: string) {
  if (state.project.kind !== 'frozen') throw Error('Frozen acceptance DTO required');
  const page = state.project.project.pages.find(p => p.slideId === slideId)!;
  const spec = page.spec as { title: string; body: string[] };
  const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 900;
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#f1f5f8'; c.fillRect(0, 0, 1600, 900);
  c.fillStyle = '#112233'; c.fillRect(0, 0, 1600, 160);
  c.font = 'bold 46px sans-serif'; c.fillStyle = '#ffffff'; c.fillText(spec.title, 60, 98);
  c.font = '24px sans-serif'; c.fillStyle = '#445566';
  c.fillText('合成验收示意 · 按冻结正文绘制 · 非模型生成图', 60, 210);
  const height = spec.body.length > 4 ? 80 : 140;
  spec.body.forEach((text, i) => {
    const y = 260 + i * height;
    c.fillStyle = i % 2 ? '#e2eaf0' : '#ffffff'; c.fillRect(60, y, 1480, height - 16);
    c.fillStyle = '#112233'; c.font = '32px sans-serif'; c.fillText(`${i + 1}  ${text}`, 90, y + 48);
  });
  c.fillStyle = '#445566'; c.font = '22px sans-serif';
  c.fillText(`第 ${page.ordinal + 1} 页 · ${slideId} · 仅检查页面切换与冻结文字`, 60, 858);
  return canvas.toDataURL('image/png').split(',')[1]!;
}

const implementation: Partial<PresalesAdapter> = {
  list: async () => [{ kind: state.project.kind, summary: state.project.project.summary }],
  load: async () => structuredClone(state.project), queue: async () => structuredClone(state.queue),
  subscribe: () => () => {},
  readImage: async input => {
    calls.push({ name: 'readImage', input });
    return { mimeType: 'image/png', base64: syntheticPreview(input.slideId) };
  },
  saveFeedback: async input => {
    if (state.project.kind !== 'frozen') throw Error('Frozen project required');
    calls.push({ name: 'saveFeedback', input });
    const page = state.project.project.pages.find(p => p.slideId === input.slideId)!;
    const saved = { baseVersionId: input.baseVersionId, revision: input.expectedRevision + 1, text: input.text, updatedAt: '2026-09-14' };
    page.feedbackDrafts = [...page.feedbackDrafts.filter(d => d.baseVersionId !== input.baseVersionId), saved];
    return saved;
  },
  delivery: async () => {
    if (state.project.kind !== 'frozen' || !state.project.project.deliverySnapshot) throw Error('No native delivery snapshot');
    calls.push({ name: 'delivery', input: state.project.project.deliverySnapshot });
    return prepareV3Delivery(state.project.project.deliverySnapshot as V3DeliverySnapshot);
  },
};
// Missing commands fail closed. No fallback to production Tauri/Codex transports.
const presales = new Proxy(implementation, {
  get(target, key: keyof PresalesAdapter) {
    if (key in target) return target[key];
    return async () => { throw Error(`Synthetic acceptance does not implement ${key}`); };
  },
}) as PresalesAdapter;
createRoot(document.getElementById('root')!).render(<App adapter={adapter} presalesAdapter={presales} />);
