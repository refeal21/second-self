import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { inspectTemplateStyle } from './template-style.js';

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const PPT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';

async function referencedTemplate(
  mutate?: (zip: JSZip) => void,
): Promise<string> {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', `
    <p:presentation xmlns:p="${PRESENTATION_NS}" xmlns:r="${PPT_REL}">
      <p:sldIdLst><p:sldId id="256" r:id="rIdSlide1"/></p:sldIdLst>
    </p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `
    <Relationships xmlns="${REL_NS}">
      <Relationship Id="rIdSlide1" Type="${PPT_REL}/slide" Target="slides/slide1.xml"/>
    </Relationships>`);
  zip.file('ppt/slides/slide1.xml', `
    <p:sld xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}">
      <p:cSld><p:spTree>
        <p:sp><p:spPr><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></p:spPr></p:sp>
        <p:sp><p:spPr><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></p:spPr></p:sp>
      </p:spTree></p:cSld>
    </p:sld>`);
  zip.file('ppt/slides/_rels/slide1.xml.rels', `
    <Relationships xmlns="${REL_NS}">
      <Relationship Id="rIdLayout" Type="${PPT_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
    </Relationships>`);
  zip.file('ppt/slideLayouts/slideLayout1.xml', `
    <p:sldLayout xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}">
      <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F7F0E8"/></a:solidFill></p:bgPr></p:bg></p:cSld>
    </p:sldLayout>`);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', `
    <Relationships xmlns="${REL_NS}">
      <Relationship Id="rIdMaster" Type="${PPT_REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
    </Relationships>`);
  zip.file('ppt/slideMasters/slideMaster1.xml', `
    <p:sldMaster xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}">
      <p:cSld><p:spTree><p:sp><p:spPr><a:solidFill><a:schemeClr val="dk1"/></a:solidFill></p:spPr></p:sp></p:spTree></p:cSld>
    </p:sldMaster>`);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', `
    <Relationships xmlns="${REL_NS}">
      <Relationship Id="rIdTheme" Type="${PPT_REL}/theme" Target="../theme/theme1.xml"/>
    </Relationships>`);
  zip.file('ppt/theme/theme1.xml', `
    <a:theme xmlns:a="${DRAWING_NS}"><a:themeElements><a:clrScheme name="Template">
      <a:dk1><a:sysClr val="windowText" lastClr="201A17"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
      <a:accent2><a:srgbClr val="7B2D26"/></a:accent2>
    </a:clrScheme></a:themeElements></a:theme>`);

  // These valid OOXML parts are deliberately orphaned and must not influence inference.
  zip.file('ppt/slides/slide99.xml', `<p:sld xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><a:srgbClr val="00FF00"/></p:sld>`);
  zip.file('ppt/slideMasters/slideMaster99.xml', `<p:sldMaster xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><a:srgbClr val="FF00FF"/></p:sldMaster>`);
  mutate?.(zip);
  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}

describe('bounded local PPTX template style inspection', () => {
  it('counts visible colors only through referenced slides, layouts, and masters', async () => {
    const inspection = await inspectTemplateStyle(await referencedTemplate());

    expect(inspection).toEqual({
      colors: [
        { color: '#7B2D26', count: 2 },
        { color: '#201A17', count: 1 },
        { color: '#F7F0E8', count: 1 },
      ],
      slideCount: 1,
      warnings: expect.arrayContaining([
        expect.stringMatching(/candidate.*confirm/i),
      ]),
    });
    expect(inspection.colors.map(({ color }) => color)).not.toContain('#4472C4');
    expect(inspection.colors.map(({ color }) => color)).not.toContain('#00FF00');
    expect(inspection.colors.map(({ color }) => color)).not.toContain('#FF00FF');
  });

  it('enumerates repeated slide and relationship elements represented as XML arrays', async () => {
    const zip = new JSZip();
    zip.file('ppt/presentation.xml', `
      <p:presentation xmlns:p="${PRESENTATION_NS}" xmlns:r="${PPT_REL}"><p:sldIdLst>
        <p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/>
      </p:sldIdLst></p:presentation>`);
    zip.file('ppt/_rels/presentation.xml.rels', `
      <Relationships xmlns="${REL_NS}">
        <Relationship Id="rId1" Type="${PPT_REL}/slide" Target="slides/slide1.xml"/>
        <Relationship Id="rId2" Type="${PPT_REL}/slide" Target="slides/slide2.xml"/>
      </Relationships>`);
    zip.file('ppt/slides/slide1.xml', `<p:sld xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><p:cSld><p:spTree><p:sp><p:spPr><a:solidFill><a:srgbClr val="AA0000"/></a:solidFill></p:spPr></p:sp></p:spTree></p:cSld></p:sld>`);
    zip.file('ppt/slides/slide2.xml', `<p:sld xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><p:cSld><p:spTree><p:sp><p:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:spPr></p:sp></p:spTree></p:cSld></p:sld>`);

    const inspection = await inspectTemplateStyle(
      await zip.generateAsync({ type: 'base64' }),
    );
    expect(inspection.slideCount).toBe(2);
    expect(inspection.colors).toEqual([
      { color: '#AA0000', count: 1 },
      { color: '#FFFFFF', count: 1 },
    ]);
  });

  it('ignores unused master text defaults and overridden style-reference blue', async () => {
    const contentsBase64 = await referencedTemplate((zip) => {
      zip.file('ppt/slides/slide1.xml', `
        <p:sld xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><p:cSld><p:spTree><p:sp>
          <p:spPr><a:solidFill><a:srgbClr val="D2232A"/></a:solidFill></p:spPr>
          <p:style><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef></p:style>
        </p:sp></p:spTree></p:cSld></p:sld>`);
      zip.file('ppt/slideMasters/slideMaster1.xml', `
        <p:sldMaster xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}">
          <p:cSld><p:spTree/></p:cSld><p:txStyles>
            <p:titleStyle><a:defRPr><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:defRPr></p:titleStyle>
            <p:bodyStyle><a:defRPr><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:defRPr></p:bodyStyle>
          </p:txStyles>
        </p:sldMaster>`);
    });

    const inspection = await inspectTemplateStyle(contentsBase64);
    expect(inspection.colors).toEqual([
      { color: '#D2232A', count: 1 },
      { color: '#F7F0E8', count: 1 },
    ]);
    expect(inspection.colors.map(({ color }) => color)).not.toContain('#4472C4');
  });

  it('counts a non-overridden shape fill style reference as visible', async () => {
    const contentsBase64 = await referencedTemplate((zip) => {
      zip.file('ppt/slides/slide1.xml', `
        <p:sld xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><p:cSld><p:spTree><p:sp>
          <p:spPr/><p:style><a:fillRef idx="1"><a:schemeClr val="accent2"/></a:fillRef></p:style>
        </p:sp></p:spTree></p:cSld></p:sld>`);
      zip.file('ppt/slideMasters/slideMaster1.xml', `<p:sldMaster xmlns:p="${PRESENTATION_NS}"><p:cSld><p:spTree/></p:cSld></p:sldMaster>`);
    });

    const inspection = await inspectTemplateStyle(contentsBase64);
    expect(inspection.colors).toEqual([
      { color: '#7B2D26', count: 1 },
      { color: '#F7F0E8', count: 1 },
    ]);
  });

  it('does not promote inherited layout placeholder defaults over slide visuals', async () => {
    const contentsBase64 = await referencedTemplate((zip) => {
      zip.file('ppt/slides/slide1.xml', `<p:sld xmlns:p="${PRESENTATION_NS}"><p:cSld><p:spTree/></p:cSld></p:sld>`);
      zip.file('ppt/slideLayouts/slideLayout1.xml', `
        <p:sldLayout xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><p:cSld><p:spTree>
          <p:sp><p:nvSpPr><p:cNvPr id="1" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
            <p:spPr><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr></p:sp>
          <p:sp><p:nvSpPr><p:cNvPr id="2" name="Brand rule"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
            <p:spPr><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></p:spPr></p:sp>
        </p:spTree></p:cSld></p:sldLayout>`);
      zip.file('ppt/slideMasters/slideMaster1.xml', `<p:sldMaster xmlns:p="${PRESENTATION_NS}"><p:cSld><p:spTree/></p:cSld></p:sldMaster>`);
    });

    const inspection = await inspectTemplateStyle(contentsBase64);
    expect(inspection.colors).toEqual([{ color: '#7B2D26', count: 1 }]);
  });

  it('inflates a shared referenced layout only once while counting it for every slide', async () => {
    const contentsBase64 = await referencedTemplate((zip) => {
      zip.file('ppt/presentation.xml', `
        <p:presentation xmlns:p="${PRESENTATION_NS}" xmlns:r="${PPT_REL}"><p:sldIdLst>
          <p:sldId id="256" r:id="rIdSlide1"/><p:sldId id="257" r:id="rIdSlide2"/>
        </p:sldIdLst></p:presentation>`);
      zip.file('ppt/_rels/presentation.xml.rels', `
        <Relationships xmlns="${REL_NS}">
          <Relationship Id="rIdSlide1" Type="${PPT_REL}/slide" Target="slides/slide1.xml"/>
          <Relationship Id="rIdSlide2" Type="${PPT_REL}/slide" Target="slides/slide2.xml"/>
        </Relationships>`);
      zip.file('ppt/slides/slide2.xml', `<p:sld xmlns:p="${PRESENTATION_NS}"><p:cSld><p:spTree/></p:cSld></p:sld>`);
      zip.file('ppt/slides/_rels/slide2.xml.rels', `
        <Relationships xmlns="${REL_NS}"><Relationship Id="rIdLayout" Type="${PPT_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`);
    });
    const loaded = await JSZip.loadAsync(contentsBase64, { base64: true });
    const prototype = Object.getPrototypeOf(loaded.file('ppt/slideLayouts/slideLayout1.xml')!) as {
      async: (...args: unknown[]) => Promise<unknown>;
    };
    const original = prototype.async;
    let sharedLayoutInflations = 0;
    const asyncSpy = vi.spyOn(prototype, 'async').mockImplementation(function (
      this: { name?: string },
      ...args: unknown[]
    ) {
      if (this.name === 'ppt/slideLayouts/slideLayout1.xml') sharedLayoutInflations += 1;
      return original.apply(this, args);
    });
    try {
      const inspection = await inspectTemplateStyle(contentsBase64);
      expect(inspection.slideCount).toBe(2);
      expect(inspection.colors).toContainEqual({ color: '#F7F0E8', count: 2 });
      expect(sharedLayoutInflations).toBe(1);
    } finally {
      asyncSpy.mockRestore();
    }
  });

  it('does not follow external relationships or read unrelated local files', async () => {
    const contentsBase64 = await referencedTemplate((zip) => {
      zip.file('ppt/slides/_rels/slide1.xml.rels', `
        <Relationships xmlns="${REL_NS}">
          <Relationship Id="external" Type="${PPT_REL}/slideLayout" Target="file:///etc/passwd" TargetMode="External"/>
        </Relationships>`);
    });

    const inspection = await inspectTemplateStyle(contentsBase64);
    expect(inspection.slideCount).toBe(1);
    expect(inspection.colors).toEqual([]);
    expect(inspection.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/external relationship/i),
      expect.stringMatching(/confirm/i),
    ]));
  });

  it.each([
    ['a DOCTYPE declaration', (zip: JSZip) => zip.file('ppt/slides/slide1.xml', '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><x>&y;</x>'), /DOCTYPE|entity/i],
    ['a macro payload', (zip: JSZip) => zip.file('ppt/vbaProject.bin', new Uint8Array([1, 2, 3])), /macro/i],
    ['an unsafe archive path', (zip: JSZip) => zip.file('../escaped.xml', '<x/>'), /unsafe|path/i],
  ])('rejects %s', async (_label, mutate, message) => {
    await expect(inspectTemplateStyle(await referencedTemplate(mutate))).rejects.toThrow(message);
  });

  it('rejects a highly-compressed XML part using metadata bounds before parsing it', async () => {
    const contentsBase64 = await referencedTemplate((zip) => {
      zip.file('ppt/slides/slide1.xml', ' '.repeat(2 * 1024 * 1024));
    });

    await expect(inspectTemplateStyle(contentsBase64)).rejects.toThrow(/inflate|uncompressed|large/i);
  });

  it.each(['', 'not base64!?', Buffer.from('not a zip').toString('base64')])(
    'rejects malformed PPTX input %j',
    async (contentsBase64) => {
      await expect(inspectTemplateStyle(contentsBase64)).rejects.toThrow(/PPTX|base64|ZIP/i);
    },
  );
});
