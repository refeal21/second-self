import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const fixtureRoot = join(repositoryRoot, 'fixtures', 'golden-project');
const sourceRoot = join(fixtureRoot, 'sources');
await mkdir(sourceRoot, { recursive: true });

const files = new Map();
files.set(
  'management-memo.pdf',
  createPdf([
    'FY2026 Management Review',
    'Revenue reached CNY 128 million, up 18 percent year over year.',
    'Gross margin improved to 42 percent and retention reached 91 percent.',
    'The next phase prioritizes enterprise expansion and delivery efficiency.',
  ]),
);
files.set(
  'kpis.csv',
  Buffer.from(
    [
      '指标,2025实际,2026目标,2026实际,2027计划,同比',
      '营业收入（百万元）,108,120,128,150,18%',
      '毛利率,37%,40%,42%,,5pct',
      '客户续约率,84%,88%,91%,,7pct',
      '交付周期（天）,42,36,31,,-26%',
    ].join('\n') + '\n',
    'utf8',
  ),
);
files.set('market-background.png', createBackgroundPng());

for (const [name, bytes] of files) {
  await writeFile(join(sourceRoot, name), bytes);
}

const referencePath = join(sourceRoot, 'style-reference.pptx');
await writeStyleReference(referencePath);
files.set('style-reference.pptx', await import('node:fs/promises').then(({ readFile }) => readFile(referencePath)));

const manifest = {
  schemaVersion: 1,
  id: 'golden-project',
  title: '2026 年经营复盘与增长计划',
  language: 'zh-CN',
  aspectRatio: '16:9',
  pageCount: 5,
  generatedAt: '2026-09-03T00:00:00.000Z',
  sources: [...files].map(([fileName, bytes]) => ({
    fileName,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
  })),
};
await writeFile(
  join(fixtureRoot, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

function createPdf(lines) {
  const content = [
    'BT',
    '/F1 18 Tf',
    '72 720 Td',
    ...lines.flatMap((line, index) => [
      index === 0 ? '' : '0 -34 Td',
      `(${escapePdfText(line)}) Tj`,
    ]),
    'ET',
  ]
    .filter(Boolean)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'binary');
}

function escapePdfText(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function createBackgroundPng() {
  const width = 1280;
  const height = 720;
  const png = new PNG({ width, height, colorType: 6 });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (width * y + x) * 4;
      const accent = Math.max(0, 1 - Math.hypot(x - 1050, y - 130) / 520);
      png.data[index] = Math.round(238 - 55 * accent);
      png.data[index + 1] = Math.round(244 - 30 * accent);
      png.data[index + 2] = Math.round(255 - 4 * accent);
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png, {
    colorType: 6,
    inputColorType: 6,
    deflateLevel: 9,
    deflateStrategy: 3,
  });
}

async function writeStyleReference(path) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'Digital Twin Workbench';
  pptx.company = 'Digital Twin Workbench';
  pptx.subject = 'Deterministic Golden Project visual reference';
  pptx.title = '商务汇报视觉参考';
  pptx.lang = 'zh-CN';
  pptx.theme = {
    headFontFace: 'Arial',
    bodyFontFace: 'Arial',
    lang: 'zh-CN',
  };
  const slide = pptx.addSlide();
  slide.background = { color: 'F7F9FC' };
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 0.25,
    h: 7.5,
    line: { color: '2563EB', transparency: 100 },
    fill: { color: '2563EB' },
  });
  slide.addText('商务汇报视觉参考', {
    x: 0.85,
    y: 0.75,
    w: 7.8,
    h: 0.8,
    fontFace: 'Arial',
    fontSize: 32,
    bold: true,
    color: '172033',
    margin: 0,
  });
  slide.addText('留白、深蓝标题、蓝绿数据强调', {
    x: 0.85,
    y: 1.8,
    w: 7.5,
    h: 0.5,
    fontFace: 'Arial',
    fontSize: 18,
    color: '475467',
    margin: 0,
  });
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 9.1,
    y: 1.0,
    w: 3.1,
    h: 4.8,
    rectRadius: 0.08,
    line: { color: 'D8E3F8', pt: 1 },
    fill: { color: 'EAF1FF' },
  });
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 9.8,
    y: 2.1,
    w: 1.8,
    h: 1.8,
    line: { color: '14B8A6', transparency: 100 },
    fill: { color: '14B8A6', transparency: 12 },
  });
  await pptx.writeFile({ fileName: path, compression: true });
  const { readFile } = await import('node:fs/promises');
  const zip = await JSZip.loadAsync(await readFile(path));
  const fixedDate = new Date('2026-09-03T00:00:00.000Z');
  for (const entry of Object.values(zip.files)) entry.date = fixedDate;
  await writeFile(
    path,
    await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      platform: 'UNIX',
    }),
  );
}
