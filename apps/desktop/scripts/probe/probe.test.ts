/** 用假的 DeepSeek 离线跑一遍探测流程，确认判定和报告逻辑正确。 */

import { addDays, localDateOf } from '@z-todo/core';
import { describe, expect, it } from 'vitest';
import type { AiCall, AiResponse } from '../../src/host/types';
import { renderReport, runProbe, type ProbeOptions, type Transport } from './probe';

const NOW = Date.parse('2026-10-11T07:30+08:00');
const TZ = 480;
const OPTS: ProbeOptions = { nowMs: NOW, tzOffsetMin: TZ, repeat: 1, retryDelayMs: 0 };

function draftArgs() {
  const d = addDays(localDateOf(NOW, TZ), 1);
  return {
    category: '工作',
    tags: ['写作'],
    priority: 'high',
    predicted_intensity: 3,
    subtasks: [
      { tmp_id: 's1', kind: 'actionable', title: '列提纲', done_criteria: '提纲完成', est_min: 30, predicted_intensity: 2, depends_on: [] },
      { tmp_id: 's2', kind: 'placeholder', title: '写正文', done_criteria: '', est_min: 240, predicted_intensity: 4, depends_on: ['s1'] },
    ],
    blocks: [
      { subtask_tmp_id: 's1', start: `${d}T09:00+08:00`, end: `${d}T09:30+08:00` },
      { subtask_tmp_id: 's2', start: `${d}T14:00+08:00`, end: `${d}T18:00+08:00` },
    ],
    unschedulable: [],
  };
}

const ask = { questions: [{ id: 'q1', text: '做什么用？', options: ['作品集', '博客'] }, { id: 'q2', text: '多久上线？', options: [] }] };

function reply(body: unknown, status = 200): AiResponse {
  return { status, body, latencyMs: 800 };
}

function toolReply(name: string, args: unknown): AiResponse {
  return reply({
    choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 3000, completion_tokens: 600, prompt_cache_hit_tokens: 2000, prompt_cache_miss_tokens: 1000 },
  });
}

interface Body {
  tools?: { function: { name: string } }[];
  tool_choice?: unknown;
  messages: { content: string }[];
  response_format?: unknown;
}

const toolName = (call: AiCall) => (call.body as Body | undefined)?.tools?.[0]?.function.name;
const userText = (call: AiCall) => (call.body as Body | undefined)?.messages.at(-1)?.content ?? '';
const isSplit = (call: AiCall) => call.path === 'chat/completions' && !!(call.body as Body).tools?.some((t) => t.function.name === 'submit_split');

/** 行为正确的假 DeepSeek。 */
const goodDeepSeek: Transport = async (call: AiCall) => {
  if (call.path === 'models') return reply({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] });
  const body = call.body as Body;
  if (toolName(call) === 'strict_check') return reply({ error: { message: 'Invalid schema: all properties must be required' } }, 400);
  if (toolName(call) === 'echo_note') return toolReply('echo_note', { note: null });
  if (body.response_format) {
    return reply({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ function: 'submit_split', arguments: draftArgs() }) } }] });
  }
  const user = userText(call);
  const vague = user.includes('主任务：做个网站') && user.includes('追问轮次：0');
  return vague && body.tool_choice === 'required' ? toolReply('ask_questions', ask) : toolReply('submit_split', draftArgs());
};

describe('探测流程（假的 DeepSeek）', () => {
  it('能力都正常时判定通过，并统计用量与费用', async () => {
    const report = await runProbe(goodDeepSeek, { ...OPTS, repeat: 2 });
    expect(report.models.result).toBe(true);
    expect(report.enforced.result).toBe(true);
    expect(report.nullable.result).toBe(true);
    expect(report.summary.strict).toEqual({ total: 8, conclusive: 8, valid: 8, unexpected: 0, inconclusive: 0 });
    expect(report.summary.json).toEqual({ total: 2, conclusive: 2, valid: 2, emptyContent: 0, inconclusive: 0 });
    expect(report.summary.askObserved).toEqual({ asked: 2, of: 2 });
    expect(report.summary.tokens.prompt).toBe(3000 * 8);
    expect(report.summary.estimatedCostYuan).toBeGreaterThan(0);
    expect(report.verdict.pass).toBe(true);
    const md = renderReport(report);
    expect(md).toContain('结论：第 0 步通过');
    expect(md).toContain('服务端校验 strict schema：生效');
    expect(md).not.toContain('无法判断：');
  });

  it('追问满两轮的请求强制指定 submit_split', async () => {
    const seen: unknown[] = [];
    await runProbe(
      async (call) => {
        seen.push((call.body as Body | undefined)?.tool_choice);
        return goodDeepSeek(call);
      },
      { ...OPTS, only: ['strict'] },
    );
    expect(seen).toContainEqual({ type: 'function', function: { name: 'submit_split' } });
  });

  it('参数不合 schema、JSON 模式返回空内容、返回思维链时判定不通过并写明原因', async () => {
    let split = 0;
    const flaky: Transport = async (call) => {
      if ((call.body as Body | undefined)?.response_format) return reply({ choices: [{ finish_reason: 'stop', message: { content: '' } }] });
      const r = await goodDeepSeek(call);
      if (!isSplit(call)) return r;
      const n = split++;
      if (n === 0) return toolReply('submit_split', { ...draftArgs(), priority: 'urgent' });
      const b = r.body as { choices?: { message: Record<string, unknown> }[] };
      if (n === 2 && b.choices) b.choices[0]!.message.reasoning_content = '思考中…';
      return r;
    };
    const report = await runProbe(flaky, OPTS);
    expect(report.verdict.pass).toBe(false);
    expect(report.summary.strict).toMatchObject({ conclusive: 4, valid: 3, inconclusive: 0 });
    expect(report.summary.json.emptyContent).toBe(1);
    expect(report.summary.reasoningReturned).toBe(1);
    const md = renderReport(report);
    expect(md).toContain('submit_split 参数不符合 schema');
    expect(md).toContain('1 次仍返回了思维链');
    expect(md).toContain('结论：第 0 步未通过');
  });

  it('5xx 与网络错误重试后仍失败记为无法判断，不拉低通过率', async () => {
    const attempts: string[] = [];
    const unstable: Transport = async (call) => {
      if (isSplit(call) && userText(call).includes('整理书房')) {
        attempts.push('B');
        return reply({ error: { message: 'Service Unavailable' } }, 503);
      }
      if ((call.body as Body | undefined)?.response_format) throw new Error('socket hang up');
      return goodDeepSeek(call);
    };
    const report = await runProbe(unstable, OPTS);
    expect(attempts).toHaveLength(2); // 重试了一次
    expect(report.summary.strict).toEqual({ total: 4, conclusive: 3, valid: 3, unexpected: 0, inconclusive: 1 });
    expect(report.summary.json).toMatchObject({ total: 1, conclusive: 0, inconclusive: 1 });
    expect(report.verdict.pass).toBe(true);
    expect(report.verdict.lines.join('\n')).toContain('因网络或服务端原因无法判断：2 次');
    const md = renderReport(report);
    expect(md).toContain('| strict | B-study | 1 | 无法判断 |');
  });

  it('服务端资源不足（200 + insufficient_system_resource）也会重试', async () => {
    let first = true;
    const busy: Transport = async (call) => {
      if (isSplit(call) && first) {
        first = false;
        return reply({ choices: [{ finish_reason: 'insufficient_system_resource', message: { content: '' } }] });
      }
      return goodDeepSeek(call);
    };
    const report = await runProbe(busy, { ...OPTS, only: ['strict'] });
    expect(report.records[0]!.retried).toBe(true);
    expect(report.summary.strict.valid).toBe(4);
  });

  it('信息充分却选择追问：校验通过但记为非期望结果，不影响结论', async () => {
    const curious: Transport = async (call) => {
      if (isSplit(call) && userText(call).includes('综述') && (call.body as Body).tool_choice === 'required') {
        return toolReply('ask_questions', ask);
      }
      return goodDeepSeek(call);
    };
    const report = await runProbe(curious, OPTS);
    expect(report.summary.strict).toMatchObject({ conclusive: 4, valid: 4, unexpected: 1 });
    expect(report.verdict.pass).toBe(true);
    expect(report.verdict.lines.join('\n')).toContain('信息充分却选择追问：1 次');
    const md = renderReport(report);
    expect(md).toContain('| strict | A-review | 1 | 通过（非期望） | ask | unexpected_outcome |');
    expect(md).toContain('期望草稿，模型选择了追问');
  });

  it('服务端接受不合规的 strict schema 时如实报告，但不影响结论', async () => {
    const lax: Transport = async (call) => (toolName(call) === 'strict_check' ? toolReply('strict_check', { a: 'x' }) : goodDeepSeek(call));
    const report = await runProbe(lax, OPTS);
    expect(report.enforced.result).toBe(false);
    expect(report.verdict.pass).toBe(true);
    expect(report.verdict.lines.join('\n')).toContain('未生效，只能依靠本地校验');
  });

  it('所有调用都失败时不下结论', async () => {
    const down: Transport = async () => reply({ error: { message: 'Internal Server Error' } }, 500);
    const report = await runProbe(down, OPTS);
    expect(report.verdict.pass).toBe(false);
    const text = report.verdict.lines.join('\n');
    expect(text).toContain('结论：无法得出结论');
    expect(text).toContain('关闭思考模式：无法判断');
    expect(text).toContain('模型列表：未确认');
  });

  it('429 自动重试一次', async () => {
    let calls = 0;
    const report = await runProbe(
      async (call) => {
        calls++;
        if (calls === 1) return reply({ error: { message: 'rate limited' } }, 429);
        return goodDeepSeek(call);
      },
      { ...OPTS, only: ['models'] },
    );
    expect(calls).toBe(2);
    expect(report.models.result).toBe(true);
  });

  it('按模型计价，未知模型按 deepseek-flash 估算并注明', async () => {
    const flash = await runProbe(goodDeepSeek, { ...OPTS, only: ['strict'] });
    const pro = await runProbe(goodDeepSeek, { ...OPTS, only: ['strict'], model: 'deepseek-v4-pro' });
    const other = await runProbe(goodDeepSeek, { ...OPTS, only: ['strict'], model: 'deepseek-x' });
    expect(pro.summary.estimatedCostYuan).toBeGreaterThan(flash.summary.estimatedCostYuan);
    expect(other.summary.estimatedCostYuan).toBe(flash.summary.estimatedCostYuan);
    expect(other.summary.priceNote).toContain('价格未知');
  });
});
