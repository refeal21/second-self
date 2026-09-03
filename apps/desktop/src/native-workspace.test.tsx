/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createNativePipeline, type NativePptPipeline } from '../../worker/src/native-pipeline.js';
import { createDemoDesktopAdapter, type DesktopAdapter } from './desktop-adapter.js';
import { NativeWorkspacePage } from './native-workspace.js';

function qaPipeline(status: 'qa' | 'completed'): NativePptPipeline {
  const pipeline = createNativePipeline({
    id: 'project-native-ui', name: '经营复盘', goal: '管理层决策',
    createdAt: '2026-09-03T00:00:00.000Z',
  });
  pipeline.project.workflowStatus = status;
  pipeline.exportReceipt = {
    relativePath: 'exports/经营复盘.pptx', sha256: 'a'.repeat(64), byteLength: 100,
    specVersionId: 'spec-v1', visualVersionIds: {},
  };
  if (status === 'completed') {
    pipeline.qaReport = {
      status: 'passed', round: 1, projectId: pipeline.project.id,
      exportPath: pipeline.exportReceipt.relativePath,
      exportSha256: pipeline.exportReceipt.sha256,
      specVersionId: 'spec-v1', visualVersionIds: {},
      sofficePath: '/mock/soffice', rendererPath: '/mock/pdftoppm',
      pdfPath: 'qa/run-1/经营复盘.pdf', renderedPages: [],
      expectedPageCount: 0, actualPageCount: 0, blankPages: [], comparisons: [], issues: [],
      jsonReportPath: 'qa/qa-round-1.json', textReportPath: 'qa/qa-round-1.txt',
    };
  }
  return pipeline;
}

describe('native PPT QA workspace', () => {
  it('runs the production QA action and renders the real readable report path', async () => {
    const user = userEvent.setup();
    const initial = qaPipeline('qa');
    const completed = qaPipeline('completed');
    const base = createDemoDesktopAdapter();
    const runProjectQa = vi.fn(async () => completed);
    const adapter = {
      ...base,
      mode: 'tauri' as const,
      loadProjectPipeline: vi.fn(async () => initial),
      runProjectQa,
    } satisfies DesktopAdapter;
    render(<NativeWorkspacePage adapter={adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: '运行 LibreOffice 自动 QA' }));

    expect(runProjectQa).toHaveBeenCalledWith(initial.project.id);
    expect(await screen.findByText('交付完成')).toBeInTheDocument();
    expect(screen.getByText(/qa\/qa-round-1\.txt/)).toBeInTheDocument();
  });
});
