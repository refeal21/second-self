/** Synthetic component/browser harness; no native, account, or model transport. */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PairedDesignEditor } from '../src/presales/paired-design-editor.js';
import { GalleryImage } from '../src/presales/gallery/GalleryImage.js';
import { richDetails, scenarioOutline } from '../../worker/src/presales/fixtures.test-support.js';
import type { SlideDesignPlan } from '../../worker/src/presales/contracts.js';
import '../src/presales/workspace.css';
import '../src/presales/gallery/gallery.css';

declare global { interface Window { finalFixDesign: SlideDesignPlan } }
const detail = richDetails();
const outline = scenarioOutline();
detail.specs[0]!.shapes.push({ id: 'new-shape', type: 'rect', x: 0, y: 0, w: 1, h: 1, text: 'New visible leaf' });
const images = Array.from({ length: 40 }, (_, index) => ({ id: `image-${index}`, sha256: `synthetic-${index}` }));
async function preview(image: { id: string }) {
  const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 900;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#eef2fa'; context.fillRect(0, 0, 1600, 900);
  context.fillStyle = '#263048'; context.font = '64px sans-serif'; context.fillText(`Synthetic original ${image.id}`, 50, 200);
  return canvas.toDataURL('image/png');
}
function Harness() {
  const [design, setDesign] = useState(detail.designs[0]!);
  useEffect(() => { window.finalFixDesign = design; }, [design]);
  return <main className="presales-workspace"><h1>配对审核与长图库合成检查</h1>
    <section className="presales-workspace__panel presales-workspace__row">
      <PairedDesignEditor spec={detail.specs[0]!} design={design} pagePlan={outline.plan.pages[0]!} modules={outline.plan.modules} readOnly={false} onChange={setDesign} />
    </section>
    <section aria-label="40 张原图滚动检查">{images.map(image => <div className="presales-gallery__page" id={image.id} key={image.id} style={{ height: 160, borderBottom: '1px solid #dde' }}>
      <GalleryImage image={image} loadImage={preview} alt={image.id} />
    </div>)}</section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
