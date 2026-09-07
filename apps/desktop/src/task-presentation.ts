export type ProjectStatusPresentation = {
  label: string;
  tone: 'neutral' | 'active' | 'warning' | 'success' | 'danger';
};

const isoTimestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseProjectTime(value: string): number | null {
  const unixMatch = /^unix:(-?(?:0|[1-9]\d*))$/.exec(value);
  if (unixMatch) {
    const timestamp = Number(unixMatch[1]);
    return Number.isSafeInteger(timestamp) && Number.isFinite(new Date(timestamp).getTime())
      ? timestamp
      : null;
  }

  const isoMatch = isoTimestamp.exec(value);
  if (!isoMatch) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', , zone = ''] = isoMatch;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const offsetValid = zone === 'Z' || (() => {
    const [offsetHour = Number.NaN, offsetMinute = Number.NaN] = zone.slice(1).split(':').map(Number);
    return offsetHour <= 23 && offsetMinute <= 59;
  })();

  if (
    ![year, month, day, hour, minute, second].every(Number.isInteger) ||
    month < 1 || month > 12 ||
    day < 1 || daysInMonth === undefined || day > daysInMonth ||
    hour > 23 || minute > 59 || second > 59 ||
    !offsetValid
  ) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function formatProjectTime(value: string, timeZone?: string): string {
  const timestamp = parseProjectTime(value);
  if (timestamp === null) return '—';

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(timeZone === undefined ? {} : { timeZone }),
    }).formatToParts(timestamp);
    const valueOf = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value;
    const year = valueOf('year');
    const month = valueOf('month');
    const day = valueOf('day');
    const hour = valueOf('hour');
    const minute = valueOf('minute');
    return year && month && day && hour && minute
      ? `${year}-${month}-${day} ${hour}:${minute}`
      : '—';
  } catch {
    return '—';
  }
}

export function sortProjectsByUpdatedAt<T extends { updatedAt: string }>(projects: readonly T[]): T[] {
  return projects
    .map((project, index) => ({ project, index, timestamp: parseProjectTime(project.updatedAt) }))
    .sort((left, right) => {
      if (left.timestamp === null && right.timestamp === null) return left.index - right.index;
      if (left.timestamp === null) return 1;
      if (right.timestamp === null) return -1;
      return right.timestamp - left.timestamp || left.index - right.index;
    })
    .map(({ project }) => project);
}

const workflowPresentations: Readonly<Record<string, ProjectStatusPresentation>> = {
  intake: { label: '待开始', tone: 'neutral' },
  source_analysis: { label: '待生成大纲', tone: 'active' },
  outline_review: { label: '待审批', tone: 'warning' },
  detail_review: { label: '待细化', tone: 'active' },
  visual_review: { label: '待视觉确认', tone: 'warning' },
  conversion: { label: '待转换', tone: 'active' },
  qa: { label: '待检查', tone: 'active' },
  completed: { label: '已完成', tone: 'success' },
  blocked: { label: '已阻塞', tone: 'danger' },
};

const legacyWorkflowByStage: Readonly<Record<string, string>> = {
  材料: 'intake',
  材料分析: 'source_analysis',
  大纲审批: 'outline_review',
  逐页细化: 'detail_review',
  内容生成: 'detail_review',
  视觉审批: 'visual_review',
  可编辑转换: 'conversion',
  质量检查: 'qa',
  已完成: 'completed',
  可恢复阻塞: 'blocked',
};

export function projectStatus(project: {
  workflowStatus?: string;
  stage: string;
  pendingMutation?: unknown;
}): ProjectStatusPresentation {
  const workflowStatus = project.workflowStatus === undefined
    ? legacyWorkflowByStage[project.stage]
    : project.workflowStatus;
  const terminal = workflowStatus === 'completed' || workflowStatus === 'blocked';
  if (project.pendingMutation && !terminal) return { label: '处理中', tone: 'active' };
  return workflowPresentations[workflowStatus ?? ''] ?? { label: '状态未知', tone: 'neutral' };
}
