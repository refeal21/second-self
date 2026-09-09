// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  TemplateStyleInspection,
  VisualStyleProfile,
  VisualStyleState,
} from '../../worker/src/visual-style.js';
import { VisualStylePanel } from './visual-style-panel.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const neutralProfile: VisualStyleProfile = {
  primaryColor: '#333333',
  backgroundColor: '#FFFFFF',
  textColor: '#222222',
  accentColors: ['#666666'],
  instructions: '',
  template: null,
};

const neutralStyle: VisualStyleState = {
  revision: 0,
  profile: null,
  locked: false,
};

const inspection: TemplateStyleInspection = {
  colors: [
    { color: '#FFFFFF', count: 20 },
    { color: '#D91E18', count: 12 },
    { color: '#8C8C8C', count: 10 },
    { color: '#F2B705', count: 4 },
  ],
  slideCount: 9,
  warnings: ['部分渐变色未计入统计'],
};

function pptxFile(bytes: number[] = [1, 2, 3]): File {
  const file = new File([new Uint8Array(bytes)], 'reference.pptx', {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: vi.fn(async () => Uint8Array.from(bytes).buffer),
  });
  return file;
}

function digest(bytes: number[]): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

async function expandPanel(user = userEvent.setup()): Promise<void> {
  const heading = screen.getByText('项目配色与模板参考');
  const details = heading.closest('details');
  expect(details).not.toHaveAttribute('open');
  await user.click(heading);
  expect(details).toHaveAttribute('open');
}

describe('VisualStylePanel', () => {
  it('keeps template inspection as a suggestion until the user explicitly confirms save', async () => {
    const user = userEvent.setup();
    const inspectTemplate = vi.fn(async () => inspection);
    const onSave = vi.fn(async (profile: VisualStyleProfile): Promise<VisualStyleState> => ({
      revision: 1,
      profile,
      locked: false,
    }));
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockResolvedValue(
      digest(new Array(32).fill(0xab)),
    );

    render(
      <VisualStylePanel
        style={neutralStyle}
        busy={false}
        inspectTemplate={inspectTemplate}
        onSave={onSave}
      />,
    );
    await expandPanel(user);

    const file = pptxFile();
    fireEvent.change(screen.getByLabelText('选择 PPTX 模板'), {
      target: { files: [file] },
    });

    const suggestedPrimary = await screen.findByRole('button', {
      name: '使用 #D91E18 作为主色',
    });
    expect(inspectTemplate).toHaveBeenCalledWith({
      fileName: 'reference.pptx',
      contentsBase64: 'AQID',
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('检测到 9 页；以下颜色只是建议，需要确认后才会保存。')).toBeVisible();
    expect(screen.getByText('仅提取配色；尚未将图片插入模板')).toBeVisible();
    expect(screen.getByText('部分渐变色未计入统计')).toBeVisible();

    await user.click(suggestedPrimary);
    expect(screen.getByLabelText('主色')).toHaveValue('#D91E18');
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认保存配色' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      ...neutralProfile,
      primaryColor: '#D91E18',
      template: {
        fileName: 'reference.pptx',
        sha256: 'abababababababababababababababababababababababababababababababab',
        relativePath: 'visuals/style-templates/abababababababababababababababababababababababababababababababab.pptx',
      },
    }, 'AQID');
  });

  it('edits role colors and instructions as a draft and reports dirty and saved style changes', async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    const onStyleChange = vi.fn();
    const onSave = vi.fn(async (profile: VisualStyleProfile): Promise<VisualStyleState> => ({
      revision: 4,
      profile,
      locked: false,
    }));
    const savedStyle: VisualStyleState = {
      revision: 3,
      locked: false,
      profile: {
        ...neutralProfile,
        primaryColor: '#711A21',
        accentColors: ['#B28A52'],
        instructions: '留出宽松页边距',
        template: {
          fileName: 'saved.pptx',
          sha256: 'c'.repeat(64),
          relativePath: `visuals/style-templates/${'c'.repeat(64)}.pptx`,
        },
      },
    };

    render(
      <VisualStylePanel
        style={savedStyle}
        busy={false}
        inspectTemplate={vi.fn()}
        onSave={onSave}
        onDirtyChange={onDirtyChange}
        onStyleChange={onStyleChange}
      />,
    );
    await expandPanel(user);

    await user.clear(screen.getByLabelText('主色'));
    await user.type(screen.getByLabelText('主色'), '#4A1F24');
    await user.clear(screen.getByLabelText('背景色'));
    await user.type(screen.getByLabelText('背景色'), '#FFF9F0');
    await user.clear(screen.getByLabelText('文字色'));
    await user.type(screen.getByLabelText('文字色'), '#281A18');
    await user.clear(screen.getByLabelText('强调色（逗号分隔）'));
    await user.type(screen.getByLabelText('强调色（逗号分隔）'), '#B88746, #8C3B32');
    await user.clear(screen.getByLabelText('视觉说明'));
    await user.type(screen.getByLabelText('视觉说明'), '低饱和、留白充足');

    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认保存配色' }));

    const expectedProfile: VisualStyleProfile = {
      ...savedStyle.profile!,
      primaryColor: '#4A1F24',
      backgroundColor: '#FFF9F0',
      textColor: '#281A18',
      accentColors: ['#B88746', '#8C3B32'],
      instructions: '低饱和、留白充足',
    };
    await waitFor(() => expect(onStyleChange).toHaveBeenCalledWith({
      revision: 4,
      profile: expectedProfile,
      locked: false,
    }));
    expect(onSave).toHaveBeenCalledWith(expectedProfile, undefined);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('uses a neutral non-blue default and disables every edit when the style is locked', async () => {
    render(
      <VisualStylePanel
        style={{ ...neutralStyle, locked: true }}
        busy={false}
        inspectTemplate={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    await expandPanel();

    expect(screen.getByLabelText('主色')).toHaveValue('#333333');
    expect(screen.getByLabelText('背景色')).toHaveValue('#FFFFFF');
    expect(screen.getByLabelText('文字色')).toHaveValue('#222222');
    expect(screen.getByLabelText('强调色（逗号分隔）')).toHaveValue('#666666');
    expect(screen.getByLabelText('选择 PPTX 模板')).toBeDisabled();
    expect(screen.getByLabelText('主色')).toBeDisabled();
    expect(screen.getByLabelText('背景色')).toBeDisabled();
    expect(screen.getByLabelText('文字色')).toBeDisabled();
    expect(screen.getByLabelText('强调色（逗号分隔）')).toBeDisabled();
    expect(screen.getByLabelText('视觉说明')).toBeDisabled();
    expect(screen.getByRole('button', { name: '配色已锁定' })).toBeDisabled();
    expect(screen.getByText('首次视觉稿获批后配色会永久锁定；重新打开视觉稿也不会解锁。')).toBeVisible();
  });

  it('shows accessible file and save errors and restores controls after a failed save', async () => {
    const user = userEvent.setup();
    const inspectTemplate = vi.fn(async () => inspection);
    let rejectSave!: (reason: Error) => void;
    const onSave = vi.fn(() => new Promise<VisualStyleState>((_resolve, reject) => {
      rejectSave = reject;
    }));

    render(
      <VisualStylePanel
        style={neutralStyle}
        busy={false}
        inspectTemplate={inspectTemplate}
        onSave={onSave}
      />,
    );
    await expandPanel(user);

    fireEvent.change(screen.getByLabelText('选择 PPTX 模板'), {
      target: { files: [new File(['not pptx'], 'notes.txt')] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('请选择 .pptx 文件');
    expect(inspectTemplate).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('主色'));
    await user.type(screen.getByLabelText('主色'), '#504030');
    await user.click(screen.getByRole('button', { name: '确认保存配色' }));
    expect(await screen.findByRole('button', { name: '正在保存…' })).toBeDisabled();
    expect(screen.getByLabelText('主色')).toBeDisabled();
    await act(async () => rejectSave(new Error('保存冲突，请重新加载')));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存冲突，请重新加载');
    expect(screen.getByRole('button', { name: '确认保存配色' })).toBeEnabled();
    expect(screen.getByLabelText('主色')).toBeEnabled();
  });

  it('rejects a file larger than 50 MiB before reading or inspecting it', async () => {
    const inspectTemplate = vi.fn();
    const oversized = pptxFile();
    const arrayBuffer = vi.fn();
    Object.defineProperties(oversized, {
      size: { value: 50 * 1024 * 1024 + 1 },
      arrayBuffer: { value: arrayBuffer },
    });

    render(
      <VisualStylePanel
        style={neutralStyle}
        busy={false}
        inspectTemplate={inspectTemplate}
        onSave={vi.fn()}
      />,
    );
    await expandPanel();
    fireEvent.change(screen.getByLabelText('选择 PPTX 模板'), {
      target: { files: [oversized] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('PPTX 不能超过 50 MiB');
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(inspectTemplate).not.toHaveBeenCalled();
  });

  it('ignores an inspection that resolves after unmount', async () => {
    let resolveInspection!: (value: TemplateStyleInspection) => void;
    const inspectTemplate = vi.fn(() => new Promise<TemplateStyleInspection>((resolve) => {
      resolveInspection = resolve;
    }));
    const onDirtyChange = vi.fn();
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockResolvedValue(digest(new Array(32).fill(1)));

    const view = render(
      <VisualStylePanel
        style={neutralStyle}
        busy={false}
        inspectTemplate={inspectTemplate}
        onSave={vi.fn()}
        onDirtyChange={onDirtyChange}
      />,
    );
    await expandPanel();
    fireEvent.change(screen.getByLabelText('选择 PPTX 模板'), {
      target: { files: [pptxFile()] },
    });
    await waitFor(() => expect(inspectTemplate).toHaveBeenCalledTimes(1));
    onDirtyChange.mockClear();
    view.unmount();

    await act(async () => {
      resolveInspection(inspection);
      await Promise.resolve();
    });

    expect(onDirtyChange).not.toHaveBeenCalled();
  });

  it('keeps the workspace dirty while inspection or an unchanged-default save is in flight', async () => {
    let resolveInspection!: (value: TemplateStyleInspection) => void;
    const inspectTemplate = vi.fn(() => new Promise<TemplateStyleInspection>((resolve) => {
      resolveInspection = resolve;
    }));
    const inspectionDirty = vi.fn();
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockResolvedValue(digest(new Array(32).fill(2)));

    const inspected = render(
      <VisualStylePanel
        style={{ revision: 2, profile: neutralProfile, locked: false }}
        busy={false}
        inspectTemplate={inspectTemplate}
        onSave={vi.fn()}
        onDirtyChange={inspectionDirty}
      />,
    );
    await expandPanel();
    fireEvent.change(screen.getByLabelText('选择 PPTX 模板'), {
      target: { files: [pptxFile()] },
    });
    await waitFor(() => expect(inspectTemplate).toHaveBeenCalledTimes(1));
    expect(inspectionDirty).toHaveBeenLastCalledWith(true);
    await act(async () => resolveInspection(inspection));
    inspected.unmount();

    let resolveSave!: (value: VisualStyleState) => void;
    const onSave = vi.fn(() => new Promise<VisualStyleState>((resolve) => {
      resolveSave = resolve;
    }));
    const saveDirty = vi.fn();
    render(
      <VisualStylePanel
        style={neutralStyle}
        busy={false}
        inspectTemplate={vi.fn()}
        onSave={onSave}
        onDirtyChange={saveDirty}
      />,
    );
    await expandPanel();
    await userEvent.click(screen.getByRole('button', { name: '确认保存配色' }));
    expect(onSave).toHaveBeenCalledWith(neutralProfile, undefined);
    expect(await screen.findByRole('button', { name: '正在保存…' })).toBeDisabled();
    expect(saveDirty).toHaveBeenLastCalledWith(true);
    await act(async () => resolveSave({ revision: 1, profile: neutralProfile, locked: false }));
    await waitFor(() => expect(saveDirty).toHaveBeenLastCalledWith(false));
  });

  it('does not discard a draft when the same saved profile arrives with different JSON key order', async () => {
    const user = userEvent.setup();
    const style: VisualStyleState = { revision: 5, profile: neutralProfile, locked: false };
    const view = render(
      <VisualStylePanel
        style={style}
        busy={false}
        inspectTemplate={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    await expandPanel(user);
    await user.clear(screen.getByLabelText('主色'));
    await user.type(screen.getByLabelText('主色'), '#5A3028');

    const reorderedProfile: VisualStyleProfile = {
      template: null,
      instructions: '',
      accentColors: ['#666666'],
      textColor: '#222222',
      backgroundColor: '#FFFFFF',
      primaryColor: '#333333',
    };
    view.rerender(
      <VisualStylePanel
        style={{ revision: 5, profile: reorderedProfile, locked: false }}
        busy={false}
        inspectTemplate={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('主色')).toHaveValue('#5A3028');
  });

  it('continues accepting template results under React StrictMode and permits an empty accent list', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (profile: VisualStyleProfile): Promise<VisualStyleState> => ({
      revision: 1,
      profile,
      locked: false,
    }));
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockResolvedValue(digest(new Array(32).fill(3)));
    render(
      <StrictMode>
        <VisualStylePanel
          style={neutralStyle}
          busy={false}
          inspectTemplate={vi.fn(async () => inspection)}
          onSave={onSave}
        />
      </StrictMode>,
    );
    await expandPanel(user);
    fireEvent.change(screen.getByLabelText('选择 PPTX 模板'), {
      target: { files: [pptxFile()] },
    });
    expect(await screen.findByText('检测到 9 页；以下颜色只是建议，需要确认后才会保存。')).toBeVisible();
    await user.clear(screen.getByLabelText('强调色（逗号分隔）'));
    await user.click(screen.getByRole('button', { name: '确认保存配色' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]?.[0].accentColors).toEqual([]);
  });
});
