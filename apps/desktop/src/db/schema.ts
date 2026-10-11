/**
 * Drizzle 表定义：只用于类型安全地构造 SQL，执行一律交给宿主端口。
 *
 * 表结构的事实来源是 src-tauri/db/migrations 下的 SQL（CHECK 约束、索引、视图都在那里）。
 * 这里必须与迁移后的库逐列一致，schema-drift.test.ts 会检查表名、列名、非空、主键。
 * 时间一律是 UTC 毫秒整数，不使用 Drizzle 的 timestamp 模式。
 */

import { sql } from 'drizzle-orm';
import { integer, primaryKey, sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

const version = () => integer('version').notNull().default(1);
const createdAt = () => integer('created_at').notNull();
const updatedAt = () => integer('updated_at').notNull();

export const category = sqliteTable('category', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  color: text('color').notNull(),
  noAi: integer('no_ai').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tag = sqliteTable('tag', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: createdAt(),
});

export const task = sqliteTable('task', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  note: text('note'),
  categoryId: text('category_id').references(() => category.id),
  priority: text('priority', { enum: ['high', 'medium', 'low'] }).notNull().default('medium'),
  lifecycle: text('lifecycle', {
    enum: ['inbox', 'draft', 'active', 'done', 'abandoned', 'missed', 'skipped', 'suspended'],
  }).notNull(),
  abandonReason: text('abandon_reason'),
  deadlineKind: text('deadline_kind', { enum: ['none', 'hard', 'soft'] }).notNull().default('none'),
  deadlineAt: integer('deadline_at'),
  deadlineDateOnly: integer('deadline_date_only').notNull().default(0),
  predictedIntensity: integer('predicted_intensity'),
  noAi: integer('no_ai').notNull().default(0),
  origin: text('origin', { enum: ['manual', 'inbox', 'template', 'recurrence'] }).notNull(),
  splitGranularity: text('split_granularity', { enum: ['coarse', 'medium', 'fine', 'none'] }),
  recurrenceId: text('recurrence_id'),
  recurrenceDate: text('recurrence_date'),
  overrideFields: text('override_fields').notNull().default(sql`'[]'`),
  deletedAt: integer('deleted_at'),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const taskTag = sqliteTable(
  'task_tag',
  {
    taskId: text('task_id').notNull().references(() => task.id, { onDelete: 'cascade' }),
    tagId: text('tag_id').notNull().references(() => tag.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.tagId] })],
);

export const subtask = sqliteTable('subtask', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => task.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['actionable', 'placeholder'] }).notNull(),
  title: text('title').notNull(),
  doneCriteria: text('done_criteria'),
  status: text('status', {
    enum: ['todo', 'in_progress', 'waiting', 'done', 'skipped', 'archived'],
  }).notNull(),
  waitingNote: text('waiting_note'),
  estAiMin: integer('est_ai_min'),
  estMin: integer('est_min'),
  predictedIntensity: integer('predicted_intensity'),
  sortOrder: integer('sort_order').notNull(),
  refinedFromId: text('refined_from_id').references((): AnySQLiteColumn => subtask.id),
  doneAt: integer('done_at'),
  overrunNotified: integer('overrun_notified').notNull().default(0),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const subtaskEstimate = sqliteTable('subtask_estimate', {
  id: text('id').primaryKey(),
  subtaskId: text('subtask_id').notNull().references(() => subtask.id, { onDelete: 'cascade' }),
  minutes: integer('minutes').notNull(),
  source: text('source', { enum: ['ai', 'confirmed', 'revised'] }).notNull(),
  at: integer('at').notNull(),
});

export const subtaskDep = sqliteTable(
  'subtask_dep',
  {
    preId: text('pre_id').notNull().references(() => subtask.id, { onDelete: 'cascade' }),
    postId: text('post_id').notNull().references(() => subtask.id, { onDelete: 'cascade' }),
    active: integer('active').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.preId, t.postId] })],
);

export const planBlock = sqliteTable('plan_block', {
  id: text('id').primaryKey(),
  subtaskId: text('subtask_id').notNull().references(() => subtask.id, { onDelete: 'cascade' }),
  startAt: integer('start_at').notNull(),
  endAt: integer('end_at').notNull(),
  tzOffsetMin: integer('tz_offset_min').notNull(),
  locked: integer('locked').notNull().default(0),
  source: text('source', { enum: ['ai', 'manual'] }).notNull(),
  state: text('state', { enum: ['active', 'archived'] }).notNull().default('active'),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workSession = sqliteTable('work_session', {
  id: text('id').primaryKey(),
  subtaskId: text('subtask_id').notNull().references(() => subtask.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['timer', 'range', 'duration'] }).notNull(),
  startAt: integer('start_at'),
  endAt: integer('end_at'),
  durationMs: integer('duration_ms'),
  localDate: text('local_date'),
  tzOffsetMin: integer('tz_offset_min').notNull(),
  lastAliveAt: integer('last_alive_at'),
  planBlockId: text('plan_block_id').references(() => planBlock.id, { onDelete: 'set null' }),
  intensitySnapshot: integer('intensity_snapshot'),
  origin: text('origin', { enum: ['timer', 'manual', 'gap_confirmed'] }).notNull(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const timer = sqliteTable('timer', {
  subtaskId: text('subtask_id').primaryKey().references(() => subtask.id, { onDelete: 'cascade' }),
  state: text('state', { enum: ['running', 'paused'] }).notNull(),
  openSessionId: text('open_session_id').references(() => workSession.id),
  interruptedAt: integer('interrupted_at'),
  updatedAt: updatedAt(),
});

export const timerGap = sqliteTable('timer_gap', {
  id: text('id').primaryKey(),
  subtaskId: text('subtask_id').notNull().references(() => subtask.id, { onDelete: 'cascade' }),
  startAt: integer('start_at').notNull(),
  endAt: integer('end_at'),
  cause: text('cause', { enum: ['sleep', 'quit', 'crash', 'clock_jump'] }).notNull(),
  decision: text('decision', { enum: ['pending', 'counted', 'discarded'] }).notNull().default('pending'),
  sessionId: text('session_id').references(() => workSession.id),
  decidedAt: integer('decided_at'),
});

export const completionEvent = sqliteTable('completion_event', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => task.id, { onDelete: 'cascade' }),
  completedAt: integer('completed_at').notNull(),
  tzOffsetMin: integer('tz_offset_min').notNull(),
  localDate: text('local_date').notNull(),
  reopenedAt: integer('reopened_at'),
  intensity: integer('intensity'),
  mood: integer('mood'),
  ratedAt: integer('rated_at'),
  review: text('review'),
  note: text('note'),
});

export const unavailableTime = sqliteTable('unavailable_time', {
  id: text('id').primaryKey(),
  startAt: integer('start_at').notNull(),
  endAt: integer('end_at').notNull(),
  tzOffsetMin: integer('tz_offset_min').notNull(),
  repeatRule: text('repeat_rule'),
  note: text('note'),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const dailyRecord = sqliteTable('daily_record', {
  localDate: text('local_date').primaryKey(),
  energy: integer('energy'),
  sleep: integer('sleep'),
  fatigue: integer('fatigue'),
  summary: text('summary'),
  checkinAt: integer('checkin_at'),
  updatedAt: updatedAt(),
});

export const aiRequest = sqliteTable('ai_request', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  model: text('model').notNull(),
  promptVersion: text('prompt_version').notNull(),
  requestJson: text('request_json').notNull(),
  responseJson: text('response_json'),
  status: text('status', { enum: ['ok', 'invalid', 'error', 'blocked'] }).notNull(),
  error: text('error'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  latencyMs: integer('latency_ms'),
  createdAt: createdAt(),
});

export const aiDraft = sqliteTable('ai_draft', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  taskId: text('task_id').references(() => task.id, { onDelete: 'cascade' }),
  requestId: text('request_id').references(() => aiRequest.id),
  baseRevs: text('base_revs').notNull(),
  payload: text('payload').notNull(),
  status: text('status', { enum: ['open', 'applied', 'discarded', 'stale'] }).notNull(),
  createdAt: createdAt(),
  closedAt: integer('closed_at'),
});

export const draftEdit = sqliteTable('draft_edit', {
  id: text('id').primaryKey(),
  draftId: text('draft_id').notNull().references(() => aiDraft.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  before: text('before'),
  after: text('after'),
  at: integer('at').notNull(),
});

export const changeEvent = sqliteTable('change_event', {
  id: text('id').primaryKey(),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  action: text('action').notNull(),
  before: text('before'),
  after: text('after'),
  source: text('source', { enum: ['user', 'ai_draft', 'system'] }).notNull(),
  draftId: text('draft_id'),
  meta: text('meta'),
  at: integer('at').notNull(),
});

export const appRev = sqliteTable('app_rev', {
  scope: text('scope').primaryKey(),
  rev: integer('rev').notNull(),
});

export const backupLog = sqliteTable('backup_log', {
  id: text('id').primaryKey(),
  path: text('path').notNull(),
  kind: text('kind', { enum: ['daily', 'manual', 'pre_delete', 'pre_migration', 'pre_restore'] }).notNull(),
  sizeBytes: integer('size_bytes'),
  checkOk: integer('check_ok').notNull(),
  createdAt: createdAt(),
});

export const setting = sqliteTable('setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const allTables = {
  category,
  tag,
  task,
  taskTag,
  subtask,
  subtaskEstimate,
  subtaskDep,
  planBlock,
  workSession,
  timer,
  timerGap,
  completionEvent,
  unavailableTime,
  dailyRecord,
  aiRequest,
  aiDraft,
  draftEdit,
  changeEvent,
  appRev,
  backupLog,
  setting,
};
