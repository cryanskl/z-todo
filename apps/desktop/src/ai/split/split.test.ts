import { describe, expect, it } from 'vitest';
import type { AiResponse } from '../../host/types';
import { OVERLAP_RULE, SPLIT_SYSTEM_V1 } from '../prompts/split.v1';
import { parseSplitResponse, type ChatCompletion } from './parse';
import { buildSplitCall, splitUserMessage, type SplitInput } from './request';
import type { SubmitSplitArgs } from './schema';

const input: SplitInput = {
  text: '两周内写完一篇综述初稿',
  granularity: 'medium',
  nowLocal: '2026-10-11T07:30+08:00',
  weekday: '星期日',
  deadline: { kind: 'hard', local: '2026-10-25T23:59+08:00' },
  workHours: { weekday: [['09:00', '12:00'], ['14:00', '18:00']], weekend: [['10:00', '12:00']] },
  dailyCapHours: 6,
  refineWindowDays: 7,
  categories: ['工作', '生活'],
  tags: ['写作'],
  existingBlocks: [{ start: '2026-10-12T09:00+08:00', end: '2026-10-12T10:00+08:00' }],
  qa: [],
};

describe('拆分请求', () => {
  it('strict 工具调用走 Beta 地址，关闭思考模式，模型二选一', () => {
    const { call, promptVersion } = buildSplitCall(input);
    const body = call.body as Record<string, unknown>;
    expect(call).toMatchObject({ method: 'post', path: 'chat/completions', beta: true });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.tool_choice).toBe('required');
    expect(body.model).toBe('deepseek-flash');
    expect(promptVersion).toBe('split.v1');
  });

  it('追问满两轮后强制调用 submit_split', () => {
    const q = { questions: [{ id: 'q1', text: '给谁用？' }], answers: { q1: '自己' } };
    const body = buildSplitCall({ ...input, qa: [q, q] }).call.body as Record<string, unknown>;
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'submit_split' } });
  });

  it('系统提示词逐字包含需求文档里的重叠规则，且保持不变以命中缓存', () => {
    expect(SPLIT_SYSTEM_V1).toContain(OVERLAP_RULE);
    expect(SPLIT_SYSTEM_V1).not.toMatch(/\$\{/);
  });

  it('用户消息只带已有时间块的时间，不带标题', () => {
    const msg = splitUserMessage(input);
    expect(msg).toContain('2026-10-12T09:00+08:00~2026-10-12T10:00+08:00');
    expect(msg).toContain('追问轮次：0');
  });
});

// ---------------------------------------------------------------------------

function toolResponse(name: string, args: unknown, finish = 'tool_calls'): AiResponse {
  const body: ChatCompletion = {
    choices: [{ finish_reason: finish, message: { content: '', tool_calls: [{ type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
  };
  return { status: 200, body, latencyMs: 1 };
}

const draft: SubmitSplitArgs = {
  category: '工作',
  tags: ['写作'],
  priority: 'high',
  predicted_intensity: 3,
  subtasks: [
    { tmp_id: 's1', kind: 'actionable', title: '列出要覆盖的评测方法', done_criteria: '提纲含 5 类方法', est_min: 30, predicted_intensity: 2, depends_on: [] },
    { tmp_id: 's2', kind: 'actionable', title: '写第一节', done_criteria: '1500 字', est_min: 90, predicted_intensity: 4, depends_on: ['s1'] },
    { tmp_id: 's3', kind: 'placeholder', title: '修改与定稿', done_criteria: '', est_min: 240, predicted_intensity: 3, depends_on: ['s2'] },
  ],
  blocks: [
    { subtask_tmp_id: 's1', start: '2026-10-12T09:00+08:00', end: '2026-10-12T09:30+08:00' },
    { subtask_tmp_id: 's2', start: '2026-10-12T09:30+08:00', end: '2026-10-12T11:00+08:00' },
    { subtask_tmp_id: 's3', start: '2026-10-20T14:00+08:00', end: '2026-10-20T18:00+08:00' },
  ],
  unschedulable: [],
};

describe('解析拆分响应', () => {
  it('合法草稿通过三层校验，没有质量问题', () => {
    const r = parseSplitResponse(toolResponse('submit_split', draft), { nowMs: Date.parse('2026-10-11T07:30+08:00') });
    expect(r.ok && r.value.kind === 'draft' && r.value.issues).toEqual([]);
  });

  it('合法追问', () => {
    const r = parseSplitResponse(
      toolResponse('ask_questions', { questions: [{ id: 'q1', text: '给谁用？', options: ['自己', '客户'] }, { id: 'q2', text: '预算？', options: [] }] }),
    );
    expect(r.ok && r.value.kind).toBe('ask');
  });

  it('追问只有 1 个问题时 schema 不通过（strict 模式剥掉了数量约束，本地兜底）', () => {
    const r = parseSplitResponse(toolResponse('ask_questions', { questions: [{ id: 'q1', text: '给谁用？', options: [] }] }));
    expect(!r.ok && r.error.stage).toBe('schema');
  });

  it('依赖成环、引用不存在、时间不带偏移都在本地校验被拦下', () => {
    const bad = structuredClone(draft);
    bad.subtasks[0]!.depends_on = ['s3'];
    bad.subtasks[1]!.depends_on = ['s1', 'nope'];
    bad.blocks[0]!.start = '2026-10-12 09:00';
    const r = parseSplitResponse(toolResponse('submit_split', bad));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.stage).toBe('local');
      expect(r.error.details.join('\n')).toMatch(/依赖了不存在的 nope/);
      expect(r.error.details.join('\n')).toMatch(/依赖成环/);
      expect(r.error.details.join('\n')).toMatch(/时区偏移/);
    }
  });

  it('依赖先后、晚于截止、早于现在作为质量问题报告', () => {
    const d = structuredClone(draft);
    d.blocks[1] = { subtask_tmp_id: 's2', start: '2026-10-12T09:00+08:00', end: '2026-10-12T10:30+08:00' };
    d.blocks[2] = { subtask_tmp_id: 's3', start: '2026-10-26T09:00+08:00', end: '2026-10-26T12:00+08:00' };
    const r = parseSplitResponse(toolResponse('submit_split', d), {
      nowMs: Date.parse('2026-10-12T09:10+08:00'),
      hardDeadlineMs: Date.parse('2026-10-25T23:59+08:00'),
    });
    const codes = r.ok && r.value.kind === 'draft' ? r.value.issues.map((i) => i.code).sort() : [];
    expect(codes).toEqual(['after_deadline', 'before_now', 'before_now', 'dep_order']);
  });

  it('HTTP 错误、截断、没有调用函数、参数不是 JSON', () => {
    expect(parseSplitResponse({ status: 429, body: { error: { message: 'rate' } }, latencyMs: 1 })).toMatchObject({ ok: false, error: { stage: 'http' } });
    expect(parseSplitResponse(toolResponse('submit_split', draft, 'length'))).toMatchObject({ ok: false, error: { stage: 'truncated' } });
    expect(parseSplitResponse({ status: 200, body: { choices: [{ message: { content: '好的' } }] }, latencyMs: 1 })).toMatchObject({
      ok: false,
      error: { stage: 'no_tool_call' },
    });
    const broken: AiResponse = {
      status: 200,
      body: { choices: [{ message: { tool_calls: [{ function: { name: 'submit_split', arguments: '{"a":' } }] } }] },
      latencyMs: 1,
    };
    expect(parseSplitResponse(broken)).toMatchObject({ ok: false, error: { stage: 'json' } });
  });
});
