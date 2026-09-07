import { describe, expect, it } from 'vitest';
import {
  formatProjectTime,
  parseProjectTime,
  projectStatus,
  sortProjectsByUpdatedAt,
} from './task-presentation.js';

describe('parseProjectTime', () => {
  it('parses legacy unix millisecond timestamps', () => {
    expect(parseProjectTime('unix:0')).toBe(0);
    expect(parseProjectTime('unix:1725366896789')).toBe(1_725_366_896_789);
  });

  it('parses ISO timestamps only when they include a timezone', () => {
    expect(parseProjectTime('2026-09-03T12:34:56Z')).toBe(1_788_438_896_000);
    expect(parseProjectTime('2026-09-03T20:34:56+08:00')).toBe(1_788_438_896_000);
    expect(parseProjectTime('2026-09-03T12:34:56')).toBeNull();
    expect(parseProjectTime('2026-09-03')).toBeNull();
  });

  it('rejects malformed, normalized-invalid, and out-of-range timestamps', () => {
    expect(parseProjectTime('unix:1.5')).toBeNull();
    expect(parseProjectTime('unix:999999999999999999999999')).toBeNull();
    expect(parseProjectTime('2026-02-30T12:00:00Z')).toBeNull();
    expect(parseProjectTime('2026-09-03T25:00:00Z')).toBeNull();
    expect(parseProjectTime('刚刚')).toBeNull();
  });
});

describe('formatProjectTime', () => {
  it('formats valid timestamps without exposing their storage representation', () => {
    expect(formatProjectTime('unix:0', 'UTC')).toBe('1970-01-01 00:00');
    expect(formatProjectTime('2026-09-03T20:34:56+08:00', 'UTC')).toBe('2026-09-03 12:34');
  });

  it('renders every invalid or demo timestamp label as an em dash', () => {
    expect(formatProjectTime('2026-02-30T12:00:00Z', 'UTC')).toBe('—');
    expect(formatProjectTime('昨天 16:43', 'UTC')).toBe('—');
    expect(formatProjectTime('刚刚', 'UTC')).toBe('—');
  });
});

describe('sortProjectsByUpdatedAt', () => {
  it('sorts valid timestamps newest first and leaves the input untouched', () => {
    const projects = [
      { id: 'old', updatedAt: 'unix:1' },
      { id: 'new', updatedAt: '1970-01-01T00:00:00.010Z' },
    ] as const;

    const sorted = sortProjectsByUpdatedAt(projects);

    expect(sorted.map(({ id }) => id)).toEqual(['new', 'old']);
    expect(projects.map(({ id }) => id)).toEqual(['old', 'new']);
    expect(sorted).not.toBe(projects);
  });

  it('places invalid timestamps last while preserving stable order for ties', () => {
    const projects = [
      { id: 'invalid-a', updatedAt: '刚刚' },
      { id: 'equal-a', updatedAt: 'unix:10' },
      { id: 'invalid-b', updatedAt: '昨天' },
      { id: 'equal-b', updatedAt: '1970-01-01T00:00:00.010Z' },
    ];

    expect(sortProjectsByUpdatedAt(projects).map(({ id }) => id)).toEqual([
      'equal-a',
      'equal-b',
      'invalid-a',
      'invalid-b',
    ]);
  });
});

describe('projectStatus', () => {
  it('maps every real workflow status to a truthful dashboard presentation', () => {
    const cases = [
      ['intake', '待开始', 'neutral'],
      ['source_analysis', '待生成大纲', 'active'],
      ['outline_review', '待审批', 'warning'],
      ['detail_review', '待细化', 'active'],
      ['visual_review', '待视觉确认', 'warning'],
      ['conversion', '待转换', 'active'],
      ['qa', '待检查', 'active'],
      ['completed', '已完成', 'success'],
      ['blocked', '已阻塞', 'danger'],
    ] as const;

    for (const [workflowStatus, label, tone] of cases) {
      expect(projectStatus({ workflowStatus, stage: 'ignored' })).toEqual({ label, tone });
    }
  });

  it('shows an in-flight mutation as processing without masking terminal states', () => {
    expect(projectStatus({ workflowStatus: 'visual_review', stage: '视觉审批', pendingMutation: {} }))
      .toEqual({ label: '处理中', tone: 'active' });
    expect(projectStatus({ workflowStatus: 'completed', stage: '质量检查', pendingMutation: {} }))
      .toEqual({ label: '已完成', tone: 'success' });
    expect(projectStatus({ workflowStatus: 'blocked', stage: '视觉审批', pendingMutation: {} }))
      .toEqual({ label: '已阻塞', tone: 'danger' });
  });

  it('falls back to legacy demo stages only when workflow status is absent', () => {
    expect(projectStatus({ stage: '材料' })).toEqual({ label: '待开始', tone: 'neutral' });
    expect(projectStatus({ stage: '视觉审批' })).toEqual({ label: '待视觉确认', tone: 'warning' });
    expect(projectStatus({ stage: '可编辑转换' })).toEqual({ label: '待转换', tone: 'active' });
    expect(projectStatus({ workflowStatus: 'unexpected', stage: '视觉审批' }))
      .toEqual({ label: '状态未知', tone: 'neutral' });
    expect(projectStatus({ stage: '演示状态' })).toEqual({ label: '状态未知', tone: 'neutral' });
  });
});
