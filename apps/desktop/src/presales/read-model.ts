import type { GalleryModel, GalleryPage } from './gallery/model.js';
import type { V3Page, V3ProjectSnapshot, V3QueueJob, V3QueueSnapshot } from './adapter.js';

const unfinished = new Set(['queued', 'dispatching', 'running', 'result_ready', 'committing', 'cancel_requested', 'outcome_unknown']);
const running = new Set(['dispatching', 'running', 'result_ready', 'committing']);
function text(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return '';
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : '';
}
export function latestImageJob(jobs: readonly V3QueueJob[], projectId: string, pageId: string): V3QueueJob | null {
  const matches = jobs.filter(job => job.kind === 'image' && job.projectId === projectId && job.slideId === pageId);
  return [...matches].reverse().find(job => unfinished.has(job.status)) ?? matches.at(-1) ?? null;
}
export function toGalleryModel(snapshot: Pick<V3ProjectSnapshot, 'summary' | 'pages'>, queue: V3QueueSnapshot, historyOnly = false): GalleryModel {
  const generationReason = !queue.capabilities?.generation ? queue.capabilities?.reason ?? '当前环境未确认图片生成能力' : null;
  const editingReason = !queue.capabilities?.referenceEditing ? queue.capabilities?.reason ?? '当前模型未确认图片参考输入能力' : null;
  const pages: GalleryPage[] = [...snapshot.pages].sort((a, b) => a.ordinal - b.ordinal).map(page => {
    const job = latestImageJob(queue.jobs, snapshot.summary.projectId, page.slideId);
    const active = job && unfinished.has(job.status);
    const current = page.versions.find(version => version.versionId === page.currentVersionId) ?? null;
    const effective = Boolean(current?.image && ((page.approval && page.approval.versionId === current.versionId && page.approval.imageSha256 === current.image.sha256) ||
      (page.originApproval && page.originApproval.versionId === current.versionId && page.originApproval.image.assetId === current.image.assetId && page.originApproval.image.sha256 === current.image.sha256)));
    const basisReason = !page.visualBasis ? '页面缺少完整视觉依据' : null;
    const activeReason = active ? job.status === 'outcome_unknown' || job.status === 'cancel_requested' ? '任务状态待核对，仍占用该页' : '该页已有生成任务' : null;
    const historyReason = historyOnly ? '此副本仅供历史查看' : null;
    const imageReason = !current?.image ? '当前版本图片不可用' : null;
    return {
      id: page.slideId, number: page.ordinal + 1, title: text(page.spec, 'title') || page.slideId,
      summary: text(page.spec, 'purpose') || text(page.spec, 'summary'),
      reviewKey: `${page.revision}:${page.currentVersionId ?? ''}:${page.visualBasis?.spec.sha256 ?? ''}:${page.visualBasis?.design.sha256 ?? ''}:${page.visualBasis?.palette.sha256 ?? ''}`,
      currentDeliveryVersionId: effective ? page.currentVersionId : null,
      candidateVersionId: effective ? null : page.currentVersionId,
      versions: page.versions.map((version, index) => ({
        id: version.versionId, revision: version.sequence, requestId: version.requestId,
        label: version.provenance && typeof version.provenance === 'object' && (version.provenance as { kind?: string }).kind === 'legacyImported' ? '原项目对照' : index === 0 ? '初稿' : `版本 ${version.sequence}`,
        manualRevision: index, approved: page.approvals.some(approval => approval.versionId === version.versionId && approval.imageSha256 === version.image?.sha256) || Boolean(page.originApprovals?.some(approval => approval.versionId === version.versionId && approval.image.sha256 === version.image?.sha256)),
        image: version.image ? { id: version.image.assetId, sha256: version.image.sha256 } : null,
        missingReason: version.missingImage ?? undefined,
      })),
      job: !job ? { state: 'idle', requestId: null } : {
        state: job.status === 'queued' ? 'queued' : running.has(job.status) ? 'running' : ['outcome_unknown', 'cancel_requested'].includes(job.status) ? 'unknown' : job.status === 'failed' ? 'failed' : 'completed',
        requestId: job.requestId, label: job.status === 'result_ready' || job.status === 'committing' ? '正在保存结果' : undefined,
        cancelReason: ['outcome_unknown', 'cancel_requested'].includes(job.status) ? '取消或结果尚未确认，仍占用队列槽位' : null,
        retryReason: job.status === 'failed' ? '失败任务需要明确创建新请求；本按钮不自动重试' : null,
      },
      observedRequestIds: queue.jobs.filter(item => item.kind === 'image' && item.projectId === snapshot.summary.projectId && item.slideId === page.slideId).map(item => item.requestId),
      eligibility: {
        generate: historyReason ?? basisReason ?? activeReason ?? generationReason ?? (page.references.length ? editingReason : null),
        edit: historyReason ?? basisReason ?? activeReason ?? editingReason ?? (!current?.image ? '请选择有图片的父版本' : null),
        adopt: historyReason ?? activeReason ?? (!current ? '尚无版本' : null),
        restore: historyReason ?? activeReason ?? (!page.approvals.length && !page.originApprovals?.length ? '没有可恢复的历史批准' : null),
        approve: historyReason ?? activeReason ?? basisReason ?? imageReason ?? (current?.provenance && typeof current.provenance === 'object' && (current.provenance as { kind?: string }).kind === 'legacyImported' ? '原始图片保留原审批，不可授予新的售前批准' : null),
      },
    };
  });
  const savedFeedback: GalleryModel['savedFeedback'] = {};
  for (const page of snapshot.pages) for (const draft of page.feedbackDrafts) {
    if (!draft.baseVersionId) continue;
    const version = page.versions.find(item => item.versionId === draft.baseVersionId);
    if (version) savedFeedback[`${page.slideId}:${version.versionId}:${version.sequence}`] = { text: draft.text, revision: draft.revision };
  }
  const missingEligible = pages.some(page => !page.candidateVersionId && !page.currentDeliveryVersionId && !page.eligibility.generate);
  return { pages, savedFeedback, queue: {
    concurrency: queue.settings.concurrency, paused: queue.settings.paused, pauseReason: null, resumeReason: null,
    generateAllMissingReason: missingEligible ? null : '没有可生成的缺失页',
  }, capabilityReasons: { reference: editingReason, edit: editingReason } };
}
export function nativePage(snapshot: V3ProjectSnapshot, pageId: string): V3Page {
  const page = snapshot.pages.find(item => item.slideId === pageId);
  if (!page) throw new Error('页面已变化，请重新载入。');
  return page;
}
