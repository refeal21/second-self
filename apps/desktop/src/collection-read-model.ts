import type { NativePptPipeline } from '../../worker/src/native-pipeline.js';
import type { ApprovalSummary } from './desktop-adapter.js';

export function derivePendingPptApprovals(
  pipelines: readonly NativePptPipeline[],
): ApprovalSummary[] {
  return pipelines.flatMap((pipeline) => {
    const base = {
      projectId: pipeline.project.id,
      title: pipeline.project.name,
      author: 'PPT 工作流',
      time: pipeline.project.updatedAt,
    };
    if (
      pipeline.project.workflowStatus === 'outline_review' &&
      pipeline.outline?.version.status === 'draft'
    ) {
      return [{
        ...base,
        id: `ppt-review:${pipeline.project.id}:outline:${pipeline.outline.version.id}`,
        detail: '整份大纲待审核',
      }];
    }
    if (pipeline.project.workflowStatus === 'detail_review' && pipeline.outlineRevisionDraft) {
      return [{ ...base,
        id: `ppt-review:${pipeline.project.id}:structure:${pipeline.outlineRevisionDraft.id}`,
        detail: '大纲结构修订待确认',
      }];
    }
    if (
      pipeline.project.workflowStatus === 'detail_review' &&
      pipeline.slideSpecs?.version.status === 'draft'
    ) {
      return [{
        ...base,
        id: `ppt-review:${pipeline.project.id}:details:${pipeline.slideSpecs.version.id}`,
        detail: '全部页面细化待审核',
      }];
    }
    const visualStage = pipeline.project.workflowStatus === 'visual_review' ||
      (pipeline.project.workflowStatus === 'blocked' &&
        pipeline.blockedCondition?.resumeStage === 'visual_review');
    const slideId = pipeline.currentSlideId;
    const visual = slideId ? pipeline.visuals[slideId]?.at(-1) : undefined;
    if (
      visualStage && slideId && visual?.version.status === 'draft' &&
      visual.relativePath.trim() !== '' && visual.byteLength > 0
    ) {
      const page = Math.max(1, (pipeline.slideSpecs?.value.findIndex((slide) => slide.id === slideId) ?? 0) + 1);
      const title = pipeline.slideSpecs?.value.find((slide) => slide.id === slideId)?.title;
      return [{
        ...base,
        id: `ppt-review:${pipeline.project.id}:visual:${visual.version.id}`,
        detail: `第 ${page} 页${title ? `「${title}」` : ''}视觉版本待审核`,
      }];
    }
    return [];
  });
}
