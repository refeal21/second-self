// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { clearGalleryImageCache, GalleryImage } from './GalleryImage.js';

afterEach(() => { cleanup(); clearGalleryImageCache(); vi.unstubAllGlobals(); });

it('recycles visited original images while scrolling a deck beyond the cache capacity', async () => {
  const callbacks: IntersectionObserverCallback[] = [];
  class Observer {
    constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('IntersectionObserver', Observer);
  const images = Array.from({ length: 40 }, (_, i) => ({ id: `long-deck-${i}`, sha256: `hash-${i}` }));
  const loadImage = vi.fn(async (image: { id: string }) => `data:image/png;base64,${image.id}`);
  render(<>{images.map(image => <GalleryImage key={image.id} image={image} loadImage={loadImage} alt={image.id} />)}</>);
  const intersect = async (index: number, visible: boolean) => act(async () => callbacks[index]!([{ isIntersecting: visible } as IntersectionObserverEntry], {} as IntersectionObserver));
  for (let i = 0; i < images.length; i++) {
    if (i > 0) await intersect(i - 1, false);
    await intersect(i, true);
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img')).toHaveAttribute('alt', `long-deck-${i}`);
  }
  await intersect(39, false);
  expect(screen.queryAllByRole('img')).toHaveLength(0);
  await intersect(0, true);
  expect(loadImage.mock.calls.filter(([image]) => image.id === 'long-deck-0')).toHaveLength(2);
  await intersect(0, false);
  await intersect(39, true);
  expect(loadImage.mock.calls.filter(([image]) => image.id === 'long-deck-39')).toHaveLength(1);
});

it('discards a late original after its thumbnail has left the viewport', async () => {
  let callback: IntersectionObserverCallback;
  class Observer { constructor(next: IntersectionObserverCallback) { callback = next; } observe() {} disconnect() {} }
  vi.stubGlobal('IntersectionObserver', Observer);
  let resolve!: (src: string) => void;
  const loadImage = () => new Promise<string>(done => { resolve = done; });
  render(<GalleryImage image={{ id: 'late', sha256: 'late' }} loadImage={loadImage} alt="late" />);
  await act(async () => callback!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  await act(async () => callback!([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
  await act(async () => resolve('data:image/png;base64,late'));
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
