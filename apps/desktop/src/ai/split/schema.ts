/**
 * 拆分请求的两个工具：信息不足时 ask_questions，信息足够时 submit_split。
 *
 * 同一份 Zod schema 有两个用途：生成 strict 工具定义（strictTool 会剥掉长度、数量约束）、
 * 校验模型输出（这里的 min/max 在本地生效）。
 * 「没有」一律用空字符串或空数组表示，不用 null（DeepSeek strict 模式未声明支持 null）。
 */

import { z } from 'zod';
import { strictTool } from '../strict-schema';

export const SUBMIT_SPLIT = 'submit_split';
export const ASK_QUESTIONS = 'ask_questions';

export const Question = z.object({
  id: z.string().describe('问题编号，如 q1'),
  text: z.string().min(1).describe('问题本身，一句话'),
  options: z.array(z.string()).max(4).describe('2–4 个常见选项，用户也可以自己写答案'),
});

export const AskQuestionsArgs = z.object({
  questions: z.array(Question).min(2).max(3).describe('2–3 个问题'),
});

export const SubtaskDraft = z.object({
  tmp_id: z.string().min(1).describe('草稿内的临时编号，如 s1；依赖和时间块用它引用子任务'),
  kind: z.enum(['actionable', 'placeholder']).describe('actionable：现在就能动手；placeholder：远期的粗粒度阶段，以后再细化'),
  title: z.string().min(1).describe('可执行子任务以动词开头'),
  done_criteria: z.string().describe('完成标准；占位子任务可以是空字符串'),
  est_min: z.number().int().min(5).max(600).describe('预计耗时，分钟'),
  predicted_intensity: z.number().int().min(1).max(5).describe('单位时间有多累：1 很轻松，5 极度费力'),
  depends_on: z.array(z.string()).describe('前置子任务的 tmp_id；前置完成后才能开始。没有就给空数组'),
});

export const BlockDraft = z.object({
  subtask_tmp_id: z.string().min(1),
  start: z.string().describe('带时区偏移的本地时间，如 2026-10-12T09:00+08:00'),
  end: z.string().describe('带时区偏移的本地时间，必须晚于 start'),
});

export const Unschedulable = z.object({
  subtask_tmp_id: z.string().min(1),
  reason: z.string().min(1),
});

export const SubmitSplitArgs = z.object({
  category: z.string().describe('从已有分类中选一个；都不合适时填空字符串'),
  tags: z.array(z.string()).max(3).describe('优先复用已有标签，最多 3 个'),
  priority: z.enum(['high', 'medium', 'low']),
  predicted_intensity: z.number().int().min(1).max(5).describe('整个主任务的预计强度'),
  subtasks: z.array(SubtaskDraft).min(1),
  blocks: z.array(BlockDraft).describe('排程建议的时间块；一个子任务可以有多个'),
  unschedulable: z.array(Unschedulable).describe('无法在硬截止前排完的子任务及原因；没有就给空数组'),
});

export type AskQuestionsArgs = z.infer<typeof AskQuestionsArgs>;
export type SubmitSplitArgs = z.infer<typeof SubmitSplitArgs>;

export const SPLIT_TOOLS = [
  strictTool(ASK_QUESTIONS, '信息不足以拆出靠谱的子任务时，向用户追问 2–3 个问题。', AskQuestionsArgs),
  strictTool(SUBMIT_SPLIT, '提交拆分草稿和排程建议。', SubmitSplitArgs),
];
