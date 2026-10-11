/**
 * 构造拆分请求。只依赖输入数据，不读系统时钟，便于测试和录制夹具。
 */

import type { AiCall } from '../../host/types';
import { SPLIT_PROMPT_VERSION, SPLIT_SYSTEM_V1 } from '../prompts/split.v1';
import { SPLIT_TOOLS, SUBMIT_SPLIT } from './schema';

export const DEFAULT_MODEL = 'deepseek-flash';

export type Granularity = 'coarse' | 'medium' | 'fine';
const GRANULARITY_LABEL: Record<Granularity, string> = { coarse: '粗', medium: '中', fine: '细' };

export interface WorkHours {
  weekday: [string, string][];
  weekend: [string, string][];
}

export interface QaRound {
  questions: { id: string; text: string }[];
  answers: Record<string, string>;
}

export interface SplitInput {
  /** 主任务原文 */
  text: string;
  granularity: Granularity;
  /** 当前本地时间，带偏移，如 2026-10-11T07:30+08:00 */
  nowLocal: string;
  /** 星期几（中文），如「星期日」 */
  weekday: string;
  deadline?: { kind: 'hard' | 'soft'; local: string };
  workHours: WorkHours;
  dailyCapHours: number;
  refineWindowDays: number;
  categories: string[];
  tags: string[];
  /** 窗口内已有的时间块，只有起止时间，不带标题（隐私：排程不需要知道别的任务是什么） */
  existingBlocks: { start: string; end: string }[];
  /** 已完成的追问轮次 */
  qa: QaRound[];
}

export interface SplitRequestOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

function hours(ranges: [string, string][]): string {
  return ranges.length ? ranges.map(([a, b]) => `${a}–${b}`).join('、') : '不工作';
}

export function splitUserMessage(input: SplitInput): string {
  const lines = [
    `主任务：${input.text}`,
    `拆分粒度：${GRANULARITY_LABEL[input.granularity]}`,
    `现在：${input.nowLocal}（${input.weekday}）`,
    `截止：${input.deadline ? `${input.deadline.kind === 'hard' ? '硬截止' : '期望完成'} ${input.deadline.local}` : '无'}`,
    `工作时段：工作日 ${hours(input.workHours.weekday)}；周末 ${hours(input.workHours.weekend)}`,
    `每日计划投入上限：${input.dailyCapHours} 小时`,
    `细化窗口：${input.refineWindowDays} 天`,
    `已有分类：${input.categories.join('、') || '无'}`,
    `已有标签：${input.tags.join('、') || '无'}`,
    `已有时间块（只有时间，没有标题）：${
      input.existingBlocks.length ? input.existingBlocks.map((b) => `${b.start}~${b.end}`).join('；') : '无'
    }`,
    `追问轮次：${input.qa.length}`,
  ];
  input.qa.forEach((round, i) => {
    lines.push(`第 ${i + 1} 轮追问与回答：`);
    for (const q of round.questions) lines.push(`- ${q.text} → ${round.answers[q.id] ?? '（未回答）'}`);
  });
  return lines.join('\n');
}

/**
 * 拆分请求：strict 工具调用（Beta 地址）、关闭思考模式。
 * 追问不到两轮时让模型二选一（tool_choice = required）；满两轮强制调用 submit_split。
 */
export function buildSplitCall(input: SplitInput, opts: SplitRequestOptions = {}): { call: AiCall; promptVersion: string } {
  const forceSubmit = input.qa.length >= 2;
  const body = {
    model: opts.model ?? DEFAULT_MODEL,
    messages: [
      { role: 'system', content: SPLIT_SYSTEM_V1 },
      { role: 'user', content: splitUserMessage(input) },
    ],
    tools: SPLIT_TOOLS,
    tool_choice: forceSubmit ? { type: 'function', function: { name: SUBMIT_SPLIT } } : 'required',
    thinking: { type: 'disabled' },
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 4096,
  };
  return { call: { method: 'post', path: 'chat/completions', beta: true, body }, promptVersion: SPLIT_PROMPT_VERSION };
}

const JSON_EXAMPLE = {
  function: 'submit_split',
  arguments: {
    category: '工作',
    tags: [],
    priority: 'medium',
    predicted_intensity: 2,
    subtasks: [
      { tmp_id: 's1', kind: 'actionable', title: '回复客户邮件', done_criteria: '邮件已发送', est_min: 15, predicted_intensity: 2, depends_on: [] },
    ],
    blocks: [{ subtask_tmp_id: 's1', start: '2026-01-05T09:00+08:00', end: '2026-01-05T09:15+08:00' }],
    unschedulable: [],
  },
};

/**
 * 备用路径：JSON Output 模式（非 Beta 地址，不带工具）。strict 工具调用报错时使用。
 * DeepSeek 要求提示词里出现「json」并给出样例；该模式偶尔返回空内容，调用方按规则重试。
 */
export function buildSplitJsonFallbackCall(
  input: SplitInput,
  opts: SplitRequestOptions = {},
): { call: AiCall; promptVersion: string } {
  const schemas = Object.fromEntries(SPLIT_TOOLS.map((t) => [t.function.name, t.function.parameters]));
  const system = `${SPLIT_SYSTEM_V1}

## 输出格式（JSON 模式）
这次不能调用函数。请直接输出一个 json 对象，形如 {"function": "submit_split" 或 "ask_questions", "arguments": {...}}。
arguments 必须符合对应函数的 JSON Schema：
${JSON.stringify(schemas)}

样例：
${JSON.stringify(JSON_EXAMPLE)}`;
  const user = input.qa.length >= 2 ? `${splitUserMessage(input)}\n这次必须输出 submit_split。` : splitUserMessage(input);
  const body = {
    model: opts.model ?? DEFAULT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    thinking: { type: 'disabled' },
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 4096,
  };
  return { call: { method: 'post', path: 'chat/completions', beta: false, body }, promptVersion: `${SPLIT_PROMPT_VERSION}+json` };
}
