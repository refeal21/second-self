import type { GeneratedVisualAsset } from './visual-generation.js';

export const STORE_GENERATED_VISUAL: unique symbol = Symbol(
  'store-generated-visual',
);

export interface GeneratedVisualEvidence {
  projectId: string;
  slideId: string;
  generated: GeneratedVisualAsset;
}
