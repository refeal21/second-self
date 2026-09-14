import { useEffect, useRef, useState } from 'react';
import type { GalleryImageIdentity } from './model.js';

const LIMIT = 24;
const cache = new Map<string, string>();
export function clearGalleryImageCache() { cache.clear(); }
const keyOf = (image: GalleryImageIdentity) => `${image.id}:${image.sha256}`;

export function GalleryImage({ image, loadImage, alt, priority = false }: {
  image: GalleryImageIdentity;
  loadImage: (image: GalleryImageIdentity) => Promise<string>;
  alt: string;
  priority?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visibleKey, setVisibleKey] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; src?: string; error?: string } | null>(null);
  const key = keyOf(image);
  const visible = priority || visibleKey === key;
  useEffect(() => {
    if (priority) return;
    setVisibleKey(null);
    if (!ref.current || typeof IntersectionObserver === 'undefined') return;
    let active = true;
    const observer = new IntersectionObserver((entries) => {
      if (active) setVisibleKey(entries.some((entry) => entry.isIntersecting) ? key : null);
    });
    observer.observe(ref.current);
    return () => { active = false; observer.disconnect(); };
  }, [key, priority]);
  useEffect(() => {
    if (!visible) { setResult(null); return; }
    let active = true;
    const cached = cache.get(key);
    if (cached) { cache.delete(key); cache.set(key, cached); setResult({ key, src: cached }); return; }
    setResult(null);
    void loadImage(image).then((src) => {
      if (!active) return;
      cache.delete(key);
      cache.set(key, src);
      if (cache.size > LIMIT) cache.delete(cache.keys().next().value!);
      setResult({ key, src });
    }, () => { if (active) setResult({ key, error: '预览暂不可用' }); });
    return () => { active = false; };
  }, [key, visible, image, loadImage]);
  return <div ref={ref} className="presales-gallery__image">
    {visible && result?.key === key && result.src ? <img src={result.src} alt={alt} loading={priority ? 'eager' : 'lazy'} />
      : <span>{result?.key === key && result.error ? result.error : visible ? '预览载入中…' : '滚动到此处载入预览'}</span>}
  </div>;
}
