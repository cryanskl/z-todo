/**
 * 解析并校验拆分请求的响应。
 *
 * 校验分三层，任何一层不过都不能进入草稿表：
 * 1. 结构：HTTP 成功、调用了预期的函数、参数是合法 JSON；
 * 2. Schema：Zod 校验（含 strict 模式剥掉的长度、数量约束）；
 * 3. 本地规则：临时编号唯一、引用存在、依赖无环、时间可解析且结束晚于开始。
 *
 * 另外给出「质量问题」（依赖先后、截止、早于现在、缺完成标准）。正式应用时这些由排程校验器
 * 在核对界面里报告；探测脚本把它们单独统计，用来评估模型的排程质量。
 */

import { findCycle } from '@z-todo/core';
import type { AiResponse } from '../../host/types';
import { ASK_QUESTIONS, AskQuestionsArgs, SUBMIT_SPLIT, SubmitSplitArgs } from './schema';

export type SplitOutcome =
  | { kind: 'ask'; args: AskQuestionsArgs }
  | { kind: 'draft'; args: SubmitSplitArgs; issues: QualityIssue[] };

export type FailureStage =
  | 'http'
  | 'server'
  | 'filtered'
  | 'truncated'
  | 'empty_content'
  | 'no_tool_call'
  | 'unknown_tool'
  | 'json'
  | 'schema'
  | 'local';

/** 服务端或网络原因造成的失败：与模型输出质量无关，可以重试。 */
export function isTransient(f: SplitFailure): boolean {
  return f.stage === 'server' || (f.stage === 'http' && (f.status === undefined || f.status === 429 || f.status >= 500));
}

export interface SplitFailure {
  stage: FailureStage;
  message: string;
  details: string[];
  /** HTTP 状态码；网络层失败时没有 */
  status?: number;
}

export type QualityCode = 'dep_order' | 'after_deadline' | 'before_now' | 'missing_criteria';

export interface QualityIssue {
  code: QualityCode;
  message: string;
}

export type Parsed<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface ChatCompletion {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { type?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
  error?: { message?: string };
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:\d{2}|Z)$/;

function fail(stage: FailureStage, message: string, details: string[] = []): { ok: false; error: SplitFailure } {
  return { ok: false, error: { stage, message, details } };
}

/** DeepSeek 的 finish_reason：length 是截断；资源不足、中断是服务端原因；content_filter 是内容被拦截。 */
function checkFinish(reason: string | undefined): { ok: false; error: SplitFailure } | null {
  switch (reason) {
    case 'length':
      return fail('truncated', '输出被截断（max_tokens 不够）');
    case 'insufficient_system_resource':
    case 'aborted':
      return fail('server', `DeepSeek 服务端中断了生成（${reason}）`);
    case 'content_filter':
      return fail('filtered', '输出被 DeepSeek 的内容策略拦截');
    default:
      return null;
  }
}

export interface SplitContext {
  /** 当前时间（UTC 毫秒），用于判断「早于现在」 */
  nowMs?: number;
  /** 硬截止（UTC 毫秒） */
  hardDeadlineMs?: number;
}

export function parseSplitResponse(resp: AiResponse, ctx: SplitContext = {}): Parsed<SplitOutcome, SplitFailure> {
  const body = resp.body as ChatCompletion;
  if (resp.status !== 200) {
    const f = fail('http', `DeepSeek 返回 HTTP ${resp.status}：${body?.error?.message ?? JSON.stringify(resp.body)}`);
    f.error.status = resp.status;
    return f;
  }
  const choice = body.choices?.[0];
  const finish = checkFinish(choice?.finish_reason);
  if (finish) return finish;
  const call = choice?.message?.tool_calls?.[0]?.function;
  if (!call?.name) {
    return fail('no_tool_call', '模型没有调用函数', choice?.message?.content ? [choice.message.content] : []);
  }

  let args: unknown;
  try {
    args = JSON.parse(call.arguments ?? '');
  } catch (e) {
    return fail('json', `函数参数不是合法 JSON：${e instanceof Error ? e.message : String(e)}`, [call.arguments ?? '']);
  }

  if (call.name === ASK_QUESTIONS) {
    const r = AskQuestionsArgs.safeParse(args);
    if (!r.success) return fail('schema', 'ask_questions 参数不符合 schema', r.error.issues.map((i) => `${i.path.join('.')}：${i.message}`));
    return { ok: true, value: { kind: 'ask', args: r.data } };
  }
  if (call.name !== SUBMIT_SPLIT) return fail('unknown_tool', `调用了未知函数 ${call.name}`);

  const r = SubmitSplitArgs.safeParse(args);
  if (!r.success) return fail('schema', 'submit_split 参数不符合 schema', r.error.issues.map((i) => `${i.path.join('.')}：${i.message}`));

  const errors = checkSplitDraft(r.data);
  if (errors.length) return fail('local', 'submit_split 未通过本地校验', errors);
  return { ok: true, value: { kind: 'draft', args: r.data, issues: qualityIssues(r.data, ctx) } };
}

/** 本地硬规则。返回错误列表，空表示通过。 */
export function checkSplitDraft(d: SubmitSplitArgs): string[] {
  const errors: string[] = [];
  const ids = d.subtasks.map((s) => s.tmp_id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) errors.push('子任务 tmp_id 有重复');

  for (const s of d.subtasks) {
    for (const p of s.depends_on) {
      if (p === s.tmp_id) errors.push(`${s.tmp_id} 依赖了自己`);
      else if (!idSet.has(p)) errors.push(`${s.tmp_id} 依赖了不存在的 ${p}`);
    }
  }
  const edges = d.subtasks.flatMap((s) => s.depends_on.filter((p) => idSet.has(p) && p !== s.tmp_id).map((p) => ({ pre: p, post: s.tmp_id })));
  const cycle = findCycle(ids, edges);
  if (cycle) errors.push(`依赖成环：${[...cycle, cycle[0]].join(' → ')}`);

  d.blocks.forEach((b, i) => {
    if (!idSet.has(b.subtask_tmp_id)) errors.push(`时间块 ${i} 引用了不存在的子任务 ${b.subtask_tmp_id}`);
    const okStart = ISO_WITH_OFFSET.test(b.start);
    const okEnd = ISO_WITH_OFFSET.test(b.end);
    if (!okStart || !okEnd) errors.push(`时间块 ${i} 的时间不是带时区偏移的 ISO 格式：${b.start} ~ ${b.end}`);
    else if (Date.parse(b.end) <= Date.parse(b.start)) errors.push(`时间块 ${i} 结束不晚于开始：${b.start} ~ ${b.end}`);
  });

  for (const u of d.unschedulable) {
    if (!idSet.has(u.subtask_tmp_id)) errors.push(`unschedulable 引用了不存在的子任务 ${u.subtask_tmp_id}`);
  }
  return errors;
}

/** 质量问题：不阻止进入核对，但正式应用时由排程校验器报告。 */
export function qualityIssues(d: SubmitSplitArgs, ctx: SplitContext): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const blocksOf = new Map<string, { start: number; end: number }[]>();
  for (const b of d.blocks) {
    const list = blocksOf.get(b.subtask_tmp_id) ?? [];
    list.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
    blocksOf.set(b.subtask_tmp_id, list);
  }

  for (const s of d.subtasks) {
    const mine = blocksOf.get(s.tmp_id) ?? [];
    if (s.kind === 'actionable' && !s.done_criteria.trim()) {
      issues.push({ code: 'missing_criteria', message: `${s.tmp_id} 是可执行子任务但没有完成标准` });
    }
    if (mine.length === 0) continue;
    const myStart = Math.min(...mine.map((b) => b.start));
    for (const p of s.depends_on) {
      const pre = blocksOf.get(p) ?? [];
      if (pre.length === 0) continue;
      const preEnd = Math.max(...pre.map((b) => b.end));
      if (myStart < preEnd) issues.push({ code: 'dep_order', message: `${s.tmp_id} 开始早于前置 ${p} 的计划完成` });
    }
  }

  for (const b of d.blocks) {
    if (ctx.hardDeadlineMs !== undefined && Date.parse(b.end) > ctx.hardDeadlineMs) {
      issues.push({ code: 'after_deadline', message: `${b.subtask_tmp_id} 的时间块晚于硬截止` });
    }
    if (ctx.nowMs !== undefined && Date.parse(b.start) < ctx.nowMs) {
      issues.push({ code: 'before_now', message: `${b.subtask_tmp_id} 的时间块早于现在` });
    }
  }
  return issues;
}

/**
 * 解析 JSON Output 备用路径的响应：把 {"function", "arguments"} 转成与工具调用相同的形状，
 * 再走同一套三层校验。空内容单独报告（DeepSeek 文档说明该模式偶尔返回空内容）。
 */
export function parseSplitJsonFallback(resp: AiResponse, ctx: SplitContext = {}): Parsed<SplitOutcome, SplitFailure> {
  if (resp.status !== 200) return parseSplitResponse(resp, ctx);
  const body = resp.body as ChatCompletion;
  const choice = body.choices?.[0];
  const finish = checkFinish(choice?.finish_reason);
  if (finish) return finish;
  const content = choice?.message?.content?.trim() ?? '';
  if (!content) return fail('empty_content', 'JSON 模式返回了空内容');
  let parsed: { function?: unknown; arguments?: unknown };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch (e) {
    return fail('json', `返回内容不是合法 JSON：${e instanceof Error ? e.message : String(e)}`, [content]);
  }
  if (typeof parsed.function !== 'string') return fail('no_tool_call', '返回的 json 里没有 function 字段', [content]);
  const asTool: AiResponse = {
    ...resp,
    body: {
      ...body,
      choices: [
        {
          finish_reason: 'tool_calls',
          message: { tool_calls: [{ type: 'function', function: { name: parsed.function, arguments: JSON.stringify(parsed.arguments ?? {}) } }] },
        },
      ],
    },
  };
  return parseSplitResponse(asTool, ctx);
}
