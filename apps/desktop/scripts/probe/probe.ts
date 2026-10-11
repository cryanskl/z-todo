/**
 * M1 第 0 步：DeepSeek 能力探测。
 *
 * 验证技术方案「AI 层」依赖的几项能力，并录制第一批夹具：
 * 1. 模型列表里有配置的模型；
 * 2. strict 工具调用 + tool_choice（required / 指定函数）+ 关闭思考模式，拆分结果稳定通过三层校验；
 * 3. 服务端是否真的校验 strict schema（发一个不合规的 schema，期望被拒绝）；
 * 4. strict 模式是否接受 anyOf null（仅供参考，正式 schema 不用 null）；
 * 5. JSON Output 备用路径是否可用、空内容出现的频率。
 *
 * 判定规则：
 * - 「通过三层校验」与「得到期望的结果」分开统计：信息充分的用例模型却选择追问，是提示词问题，不算 strict 失败；
 * - 网络错误、429、5xx、服务端资源不足等记为「无法判断」，不计入通过率；
 * - 第 0 步通过 = 可判断的 strict 调用全部通过三层校验 + 指定函数时全部返回草稿 + 没有返回思维链。
 *
 * 这个模块不读环境变量、不写文件、不发网络请求；网络由调用方传入的 transport 完成，便于离线测试。
 */

import { addDays, localDateOf, toLocalIso, weekdayOf } from '@z-todo/core';
import { z } from 'zod';
import {
  isTransient,
  parseSplitJsonFallback,
  parseSplitResponse,
  type ChatCompletion,
  type Parsed,
  type QualityCode,
  type SplitFailure,
  type SplitOutcome,
} from '../../src/ai/split/parse';
import { buildSplitCall, buildSplitJsonFallbackCall, DEFAULT_MODEL, type SplitInput } from '../../src/ai/split/request';
import { strictTool } from '../../src/ai/strict-schema';
import type { AiCall, AiResponse } from '../../src/host/types';

export type Transport = (call: AiCall) => Promise<AiResponse>;

export interface ProbeOptions {
  model?: string;
  /** 每个拆分用例跑几次 */
  repeat?: number;
  /** 当前时间（UTC 毫秒） */
  nowMs: number;
  /** 系统时区偏移（分钟，东八区为 480） */
  tzOffsetMin: number;
  /** 只跑这些检查（models、strict、enforced、nullable、json），不传则全部 */
  only?: string[];
  /** 重试前等待的毫秒数（测试里设为 0） */
  retryDelayMs?: number;
  onProgress?: (line: string) => void;
}

export type Expectation = 'draft' | 'ask' | 'either';

export interface ProbeRecord {
  caseId: string;
  attempt: number;
  path: 'strict' | 'json';
  expected: Expectation;
  request: AiCall;
  promptVersion: string;
  response?: AiResponse;
  transportError?: string;
  retried: boolean;
  outcome?: 'ask' | 'draft';
  /** 通过了结构、schema、本地规则三层校验 */
  valid: boolean;
  /** 服务端或网络原因，无法判断模型行为 */
  inconclusive: boolean;
  /** 校验通过但不是期望的结果（例如信息充分却选择追问） */
  unexpected: boolean;
  failure?: SplitFailure | { stage: 'unexpected_outcome'; message: string; details: string[] };
  issues: QualityCode[];
  reasoningReturned: boolean;
  usage: { prompt: number; completion: number; cacheHit: number };
}

type CheckResult = { result: boolean | null; note: string };

export interface ProbeReport {
  startedAt: string;
  model: string;
  repeat: number;
  models: CheckResult;
  /** 服务端会拒绝不合规的 strict schema */
  enforced: CheckResult;
  nullable: CheckResult;
  records: ProbeRecord[];
  summary: {
    strict: { total: number; conclusive: number; valid: number; unexpected: number; inconclusive: number };
    json: { total: number; conclusive: number; valid: number; emptyContent: number; inconclusive: number };
    askObserved: { asked: number; of: number };
    issues: Record<QualityCode, number>;
    succeeded: number;
    reasoningReturned: number;
    tokens: { prompt: number; completion: number; cacheHit: number };
    estimatedCostYuan: number;
    priceNote: string;
    latencyMs: { p50: number; max: number };
  };
  verdict: { pass: boolean; lines: string[] };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

interface SplitCase {
  id: string;
  title: string;
  expected: Expectation;
  input: SplitInput;
  hardDeadlineMs?: number;
}

export function buildCases(nowMs: number, tz: number): SplitCase[] {
  const today = localDateOf(nowMs, tz);
  const offset = toLocalIso(nowMs, tz).slice(16);
  const at = (date: string, hhmm: string) => `${date}T${hhmm}${offset}`;
  const daysUntilSaturday = (6 - weekdayOf(today) + 7) % 7 || 7;
  const base = {
    granularity: 'medium' as const,
    nowLocal: toLocalIso(nowMs, tz),
    weekday: WEEKDAYS[weekdayOf(today)]!,
    workHours: {
      weekday: [['09:00', '12:00'], ['14:00', '18:00']] as [string, string][],
      weekend: [['10:00', '12:00']] as [string, string][],
    },
    dailyCapHours: 6,
    refineWindowDays: 7,
    categories: ['工作', '学习', '生活'],
    tags: ['论文', '写作', '家务'],
    existingBlocks: [
      { start: at(addDays(today, 1), '09:00'), end: at(addDays(today, 1), '10:00') },
      { start: at(addDays(today, 1), '14:00'), end: at(addDays(today, 1), '15:30') },
    ],
    qa: [],
  };
  const deadlineA = at(addDays(today, 14), '23:59');
  const vague = '做个网站';
  const round1 = {
    questions: [
      { id: 'q1', text: '网站是做什么用的？' },
      { id: 'q2', text: '需要多久上线？' },
    ],
    answers: { q1: '个人作品集，展示 3 个项目', q2: '两周内' },
  };
  const round2 = {
    questions: [
      { id: 'q1', text: '用什么技术做？' },
      { id: 'q2', text: '需要自定义域名吗？' },
    ],
    answers: { q1: '静态网站生成器就行', q2: '需要' },
  };

  return [
    {
      id: 'A-review',
      title: '信息充分、有硬截止的长任务（应出草稿，含占位子任务）',
      expected: 'draft',
      input: { ...base, text: '两周内写完一篇关于检索增强生成（RAG）评测方法的综述初稿，约 6000 字', deadline: { kind: 'hard', local: deadlineA } },
      hardDeadlineMs: Date.parse(deadlineA),
    },
    {
      id: 'B-study',
      title: '信息充分、期望完成日期的短任务',
      expected: 'draft',
      input: {
        ...base,
        text: '整理书房：清理不要的旧书、理顺电脑线、换一盏台灯',
        deadline: { kind: 'soft', local: at(addDays(today, daysUntilSaturday), '18:00') },
      },
    },
    { id: 'C-vague', title: '信息不足（期望追问，直接出草稿也算结构正确）', expected: 'either', input: { ...base, text: vague } },
    {
      id: 'D-forced',
      title: '已追问两轮（指定函数调用，必须出草稿）',
      expected: 'draft',
      input: { ...base, text: vague, qa: [round1, round2] },
    },
  ];
}

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------

function usageOf(resp?: AiResponse) {
  const u = (resp?.body as ChatCompletion | undefined)?.usage;
  return { prompt: u?.prompt_tokens ?? 0, completion: u?.completion_tokens ?? 0, cacheHit: u?.prompt_cache_hit_tokens ?? 0 };
}

function reasoningOf(resp?: AiResponse): boolean {
  const m = (resp?.body as ChatCompletion | undefined)?.choices?.[0]?.message;
  return !!m?.reasoning_content?.trim();
}

function finishOf(resp?: AiResponse): string | undefined {
  return (resp?.body as ChatCompletion | undefined)?.choices?.[0]?.finish_reason;
}

/** 与正式应用一致的重试策略：网络错误、429、5xx、服务端资源不足各重试一次。 */
async function send(
  transport: Transport,
  call: AiCall,
  delayMs: number,
): Promise<{ resp?: AiResponse; error?: string; retried: boolean }> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const resp = await transport(call);
      const retryable = resp.status === 429 || resp.status >= 500 || finishOf(resp) === 'insufficient_system_resource';
      if (retryable && attempt === 0) continue;
      return { resp, retried: attempt > 0 };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { error: lastError ?? '网络错误', retried: true };
}

function networkFailure(message: string): Parsed<SplitOutcome, SplitFailure> {
  return { ok: false, error: { stage: 'http', message: `网络错误：${message}`, details: [] } };
}

function judge(expected: Expectation, parsed: Parsed<SplitOutcome, SplitFailure>) {
  if (!parsed.ok) {
    // 内容拦截不可重试，但与 strict 能力无关，同样不计入通过率
    const inconclusive = isTransient(parsed.error) || parsed.error.stage === 'filtered';
    return { valid: false, inconclusive, unexpected: false, outcome: undefined, failure: parsed.error, issues: [] as QualityCode[] };
  }
  const v = parsed.value;
  const unexpected = expected !== 'either' && expected !== v.kind;
  return {
    valid: true,
    inconclusive: false,
    unexpected,
    outcome: v.kind,
    failure: unexpected
      ? {
          stage: 'unexpected_outcome' as const,
          message: expected === 'draft' ? '期望草稿，模型选择了追问' : '期望追问，模型直接给了草稿',
          details: v.kind === 'ask' ? v.args.questions.map((q) => q.text) : [],
        }
      : undefined,
    issues: v.kind === 'draft' ? v.issues.map((i) => i.code) : [],
  };
}

// 元/百万 token，来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-10 查阅）
const PRICES: Record<string, { peak: { hit: number; miss: number; out: number }; idle: { hit: number; miss: number; out: number } }> = {
  'deepseek-flash': { peak: { hit: 0.04, miss: 2, out: 8 }, idle: { hit: 0.02, miss: 1, out: 4 } },
  'deepseek-v4-pro': { peak: { hit: 0.3, miss: 9, out: 27 }, idle: { hit: 0.15, miss: 4.5, out: 13.5 } },
};

/** 北京时间工作日 9–12、14–18 为高峰（不判断法定节假日）。 */
function isPeak(ms: number): boolean {
  const bj = new Date(ms + 8 * 3_600_000);
  const day = bj.getUTCDay();
  const h = bj.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 9 && h < 12) || (h >= 14 && h < 18));
}

async function checkModels(transport: Transport, model: string, delay: number): Promise<CheckResult> {
  const r = await send(transport, { method: 'get', path: 'models' }, delay);
  if (!r.resp) return { result: null, note: r.error ?? '网络错误' };
  if (r.resp.status !== 200) return { result: null, note: `HTTP ${r.resp.status}：${JSON.stringify(r.resp.body)}` };
  const ids = ((r.resp.body as { data?: { id: string }[] }).data ?? []).map((m) => m.id);
  return ids.includes(model)
    ? { result: true, note: `包含 ${model}（共 ${ids.join('、')}）` }
    : { result: false, note: `不包含 ${model}（只有 ${ids.join('、') || '无'}）` };
}

/** 发一个不合规的 strict schema（属性没有列进 required），服务端应当拒绝。 */
async function checkEnforced(transport: Transport, model: string, delay: number): Promise<CheckResult> {
  const call: AiCall = {
    method: 'post',
    path: 'chat/completions',
    beta: true,
    body: {
      model,
      messages: [{ role: 'user', content: '调用 strict_check，参数 a 填 "x"。' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'strict_check',
            description: '探测用',
            strict: true,
            parameters: { type: 'object', properties: { a: { type: 'string' } }, required: [], additionalProperties: false },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'strict_check' } },
      thinking: { type: 'disabled' },
      max_tokens: 50,
    },
  };
  const r = await send(transport, call, delay);
  if (!r.resp) return { result: null, note: r.error ?? '网络错误' };
  if (r.resp.status >= 400 && r.resp.status < 500 && r.resp.status !== 429) {
    return { result: true, note: `不合规的 schema 被拒绝（HTTP ${r.resp.status}）` };
  }
  if (r.resp.status === 200) return { result: false, note: '服务端接受了不合规的 schema，strict 约束可能没有在服务端执行' };
  return { result: null, note: `HTTP ${r.resp.status}` };
}

async function checkNullable(transport: Transport, model: string, delay: number): Promise<CheckResult> {
  const tool = strictTool('echo_note', '回显一条备注', z.object({ note: z.string().nullable().describe('没有备注时为 null') }), { nullable: 'anyOf' });
  const r = await send(
    transport,
    {
      method: 'post',
      path: 'chat/completions',
      beta: true,
      body: {
        model,
        messages: [{ role: 'user', content: '调用 echo_note，这条没有备注。' }],
        tools: [tool],
        tool_choice: { type: 'function', function: { name: 'echo_note' } },
        thinking: { type: 'disabled' },
        max_tokens: 100,
      },
    },
    delay,
  );
  if (!r.resp) return { result: null, note: r.error ?? '网络错误' };
  const args = (r.resp.body as ChatCompletion).choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (r.resp.status === 200) return { result: true, note: `接受，返回参数 ${args ?? '（无）'}` };
  if (r.resp.status >= 400 && r.resp.status < 500 && r.resp.status !== 429) {
    return { result: false, note: `不接受（HTTP ${r.resp.status}：${JSON.stringify(r.resp.body).slice(0, 200)}）` };
  }
  return { result: null, note: `HTTP ${r.resp.status}` };
}

export async function runProbe(transport: Transport, opts: ProbeOptions): Promise<ProbeReport> {
  const model = opts.model ?? DEFAULT_MODEL;
  const repeat = opts.repeat ?? 3;
  const delay = opts.retryDelayMs ?? 2000;
  const want = (name: string) => !opts.only || opts.only.includes(name);
  const log = opts.onProgress ?? (() => {});
  const notRun: CheckResult = { result: null, note: '未运行' };
  const records: ProbeRecord[] = [];

  let models = notRun;
  if (want('models')) {
    log('检查模型列表…');
    models = await checkModels(transport, model, delay);
  }

  let enforced = notRun;
  if (want('enforced')) {
    log('检查服务端是否校验 strict schema…');
    enforced = await checkEnforced(transport, model, delay);
  }

  const cases = buildCases(opts.nowMs, opts.tzOffsetMin);
  const runCase = async (c: SplitCase, i: number, path: 'strict' | 'json') => {
    log(`${path} ${c.id} 第 ${i}/${repeat} 次…`);
    const { call, promptVersion } = path === 'strict' ? buildSplitCall(c.input, { model }) : buildSplitJsonFallbackCall(c.input, { model });
    const r = await send(transport, call, delay);
    const ctx = { nowMs: opts.nowMs, hardDeadlineMs: c.hardDeadlineMs };
    const parsed = r.resp
      ? path === 'strict'
        ? parseSplitResponse(r.resp, ctx)
        : parseSplitJsonFallback(r.resp, ctx)
      : networkFailure(r.error ?? '');
    const j = judge(c.expected, parsed);
    records.push({
      caseId: c.id,
      attempt: i,
      path,
      expected: c.expected,
      request: call,
      promptVersion,
      response: r.resp,
      transportError: r.error,
      retried: r.retried,
      outcome: j.outcome,
      valid: j.valid,
      inconclusive: j.inconclusive,
      unexpected: j.unexpected,
      failure: j.failure,
      issues: j.issues,
      reasoningReturned: reasoningOf(r.resp),
      usage: usageOf(r.resp),
    });
  };

  if (want('strict')) {
    for (const c of cases) for (let i = 1; i <= repeat; i++) await runCase(c, i, 'strict');
  }

  let nullable = notRun;
  if (want('nullable')) {
    log('检查 strict 模式是否接受可空字段…');
    nullable = await checkNullable(transport, model, delay);
  }

  if (want('json')) {
    for (let i = 1; i <= repeat; i++) await runCase(cases[0]!, i, 'json');
  }

  return summarize({ startedAt: toLocalIso(opts.nowMs, opts.tzOffsetMin), model, repeat, models, enforced, nullable, records, nowMs: opts.nowMs });
}

function summarize(p: {
  startedAt: string;
  model: string;
  repeat: number;
  models: CheckResult;
  enforced: CheckResult;
  nullable: CheckResult;
  records: ProbeRecord[];
  nowMs: number;
}): ProbeReport {
  const strict = p.records.filter((r) => r.path === 'strict');
  const json = p.records.filter((r) => r.path === 'json');
  const conclusive = (rs: ProbeRecord[]) => rs.filter((r) => !r.inconclusive);

  const issues: Record<QualityCode, number> = { dep_order: 0, after_deadline: 0, before_now: 0, missing_criteria: 0 };
  for (const r of p.records) for (const code of r.issues) issues[code]++;
  const tokens = p.records.reduce(
    (t, r) => ({ prompt: t.prompt + r.usage.prompt, completion: t.completion + r.usage.completion, cacheHit: t.cacheHit + r.usage.cacheHit }),
    { prompt: 0, completion: 0, cacheHit: 0 },
  );
  const table = PRICES[p.model] ?? PRICES['deepseek-flash']!;
  const price = isPeak(p.nowMs) ? table.peak : table.idle;
  const cost = ((tokens.prompt - tokens.cacheHit) * price.miss + tokens.cacheHit * price.hit + tokens.completion * price.out) / 1e6;
  const priceNote = `${PRICES[p.model] ? p.model : `${p.model} 价格未知，按 deepseek-flash`}，${isPeak(p.nowMs) ? '高峰' : '空闲'}时段价格`;
  const latencies = p.records
    .map((r) => r.response?.latencyMs ?? 0)
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  const vague = conclusive(strict.filter((r) => r.caseId === 'C-vague'));

  const summary: ProbeReport['summary'] = {
    strict: {
      total: strict.length,
      conclusive: conclusive(strict).length,
      valid: conclusive(strict).filter((r) => r.valid).length,
      unexpected: strict.filter((r) => r.unexpected).length,
      inconclusive: strict.filter((r) => r.inconclusive).length,
    },
    json: {
      total: json.length,
      conclusive: conclusive(json).length,
      valid: conclusive(json).filter((r) => r.valid).length,
      emptyContent: json.filter((r) => r.failure?.stage === 'empty_content').length,
      inconclusive: json.filter((r) => r.inconclusive).length,
    },
    askObserved: { asked: vague.filter((r) => r.outcome === 'ask').length, of: vague.length },
    issues,
    succeeded: p.records.filter((r) => r.response?.status === 200).length,
    reasoningReturned: p.records.filter((r) => r.reasoningReturned).length,
    tokens,
    estimatedCostYuan: Math.round(cost * 10000) / 10000,
    priceNote,
    latencyMs: { p50: latencies[Math.floor(latencies.length / 2)] ?? 0, max: latencies.at(-1) ?? 0 },
  };

  const s = summary;
  const forced = conclusive(strict.filter((r) => r.caseId === 'D-forced'));
  const strictOk = s.strict.conclusive > 0 && s.strict.valid === s.strict.conclusive;
  const forcedOk = forced.length > 0 && forced.every((r) => r.valid && r.outcome === 'draft');
  const thinkingOk = s.succeeded > 0 && s.reasoningReturned === 0;
  const yesNo = (c: CheckResult, yes: string, no: string) => (c.result === null ? `未确认（${c.note}）` : c.result ? yes : `${no}（${c.note}）`);

  const lines = [
    `模型列表：${yesNo(p.models, p.models.note, '有问题')}`,
    `strict 工具调用：可判断的 ${s.strict.conclusive} 次中 ${s.strict.valid} 次通过三层校验${strictOk ? '' : '，未达到 100%'}`,
    `指定函数调用（追问满两轮）：${forced.length === 0 ? '无法判断' : forcedOk ? '全部返回合格草稿' : '有未返回合格草稿的情况'}`,
    `关闭思考模式：${s.succeeded === 0 ? '无法判断（没有成功的调用）' : thinkingOk ? '生效（没有返回思维链）' : `${s.reasoningReturned} 次仍返回了思维链`}`,
    `服务端校验 strict schema：${yesNo(p.enforced, '生效（不合规的 schema 被拒绝）', '未生效，只能依靠本地校验')}`,
  ];
  if (s.strict.unexpected > 0) {
    lines.push(`信息充分却选择追问：${s.strict.unexpected} 次（属于提示词问题，不影响第 0 步结论，第 7 步调整提示词）`);
  }
  lines.push(
    `信息不足时追问：${s.askObserved.asked}/${s.askObserved.of} 次选择了追问`,
    `JSON Output 备用路径：可判断的 ${s.json.conclusive} 次中 ${s.json.valid} 次通过，空内容 ${s.json.emptyContent} 次`,
    `strict 模式可空字段：${p.nullable.result === null ? '未确认' : p.nullable.result ? '接受' : '不接受'}（正式 schema 不用 null，不影响结论）`,
  );
  const inconclusive = s.strict.inconclusive + s.json.inconclusive;
  if (inconclusive > 0) lines.push(`因网络或服务端原因无法判断：${inconclusive} 次，不计入通过率；数量较多时建议稍后重跑`);

  const pass = strictOk && forcedOk && thinkingOk;
  lines.push(
    pass
      ? '结论：第 0 步通过，按技术方案以 strict 工具调用为主路径。'
      : s.strict.conclusive === 0
        ? '结论：无法得出结论（没有可判断的调用），请检查网络或稍后重跑。'
        : '结论：第 0 步未通过，见下方失败明细。',
  );
  return { ...p, summary, verdict: { pass, lines } };
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

function resultLabel(x: ProbeRecord): string {
  if (x.inconclusive) return '无法判断';
  if (!x.valid) return '失败';
  return x.unexpected ? '通过（非期望）' : '通过';
}

export function renderReport(r: ProbeReport): string {
  const s = r.summary;
  const out: string[] = [
    '# DeepSeek 能力探测报告（M1 第 0 步）',
    '',
    `- 运行时间：${r.startedAt}`,
    `- 模型：${r.model}；每个用例 ${r.repeat} 次`,
    `- 用量：输入 ${s.tokens.prompt} token（缓存命中 ${s.tokens.cacheHit}），输出 ${s.tokens.completion} token，估算费用约 ${s.estimatedCostYuan} 元（${s.priceNote}）`,
    `- 延迟：中位数 ${s.latencyMs.p50} ms，最长 ${s.latencyMs.max} ms`,
    '',
    '## 结论',
    '',
    ...r.verdict.lines.map((l) => `- ${l}`),
    '',
    '## 排程质量（只统计，不影响结论）',
    '',
    '| 问题 | 次数 |',
    '| --- | --- |',
    `| 后置子任务早于前置的计划完成 | ${s.issues.dep_order} |`,
    `| 时间块晚于硬截止 | ${s.issues.after_deadline} |`,
    `| 时间块早于现在 | ${s.issues.before_now} |`,
    `| 可执行子任务缺完成标准 | ${s.issues.missing_criteria} |`,
    '',
    '## 明细',
    '',
    '| 路径 | 用例 | 次 | 结果 | 返回 | 失败阶段 | 质量问题 | 延迟 ms |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.records.map(
      (x) =>
        `| ${x.path} | ${x.caseId} | ${x.attempt} | ${resultLabel(x)} | ${x.outcome ?? '—'} | ${x.failure?.stage ?? '—'} | ${
          x.issues.join('、') || '—'
        } | ${x.response?.latencyMs ?? '—'} |`,
    ),
  ];
  const failures = r.records.filter((x) => x.failure);
  if (failures.length) {
    out.push('', '## 失败与非期望结果详情', '');
    for (const f of failures) {
      out.push(`### ${f.path} ${f.caseId} 第 ${f.attempt} 次（${resultLabel(f)}）：${f.failure!.message}`);
      for (const d of f.failure!.details.slice(0, 10)) out.push(`- ${d.slice(0, 300)}`);
      out.push('');
    }
  }
  return out.join('\n') + '\n';
}
