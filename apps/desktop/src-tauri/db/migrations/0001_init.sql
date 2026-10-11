CREATE TABLE category (
  id          TEXT PRIMARY KEY NOT NULL,
  name        TEXT NOT NULL UNIQUE,
  color       TEXT NOT NULL,
  no_ai       INTEGER NOT NULL DEFAULT 0,          -- 整个分类不发送 AI
  sort_order  INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE tag (
  id          TEXT PRIMARY KEY NOT NULL,
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE task (                                -- 主任务
  id                  TEXT PRIMARY KEY NOT NULL,
  title               TEXT NOT NULL,
  note                TEXT,
  category_id         TEXT REFERENCES category(id),
  priority            TEXT NOT NULL DEFAULT 'medium'
                      CHECK (priority IN ('high','medium','low')),
  lifecycle           TEXT NOT NULL
                      CHECK (lifecycle IN ('inbox','draft','active','done',
                                           'abandoned','missed','skipped','suspended')),
  abandon_reason      TEXT,
  deadline_kind       TEXT NOT NULL DEFAULT 'none'
                      CHECK (deadline_kind IN ('none','hard','soft')),
  deadline_at         INTEGER,                     -- 只填日期时存当天本地 23:59:59.999
  deadline_date_only  INTEGER NOT NULL DEFAULT 0,
  predicted_intensity INTEGER CHECK (predicted_intensity BETWEEN 1 AND 5),
  no_ai               INTEGER NOT NULL DEFAULT 0,
  origin              TEXT NOT NULL
                      CHECK (origin IN ('manual','inbox','template','recurrence')),
  split_granularity   TEXT CHECK (split_granularity IN ('coarse','medium','fine','none')),
  recurrence_id       TEXT,                        -- M2
  recurrence_date     TEXT,                        -- M2，实例的本地日期
  override_fields     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(override_fields)),
  deleted_at          INTEGER,                     -- M2 回收站
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (lifecycle <> 'abandoned' OR abandon_reason IS NOT NULL),
  CHECK (deadline_kind = 'none' OR deadline_at IS NOT NULL),
  UNIQUE (recurrence_id, recurrence_date)
);

CREATE TABLE task_tag (
  task_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tag(id)  ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);

CREATE TABLE subtask (
  id                  TEXT PRIMARY KEY NOT NULL,
  task_id             TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('actionable','placeholder')),
  title               TEXT NOT NULL,
  done_criteria       TEXT,
  status              TEXT NOT NULL
                      CHECK (status IN ('todo','in_progress','waiting','done','skipped','archived')),
  waiting_note        TEXT,
  est_ai_min          INTEGER,                     -- AI 原始预估，写入后不再修改
  est_min             INTEGER,                     -- 当前确认预估
  predicted_intensity INTEGER CHECK (predicted_intensity BETWEEN 1 AND 5),
  sort_order          INTEGER NOT NULL,
  refined_from_id     TEXT REFERENCES subtask(id), -- 由哪个占位细化而来
  done_at             INTEGER,
  overrun_notified    INTEGER NOT NULL DEFAULT 0,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (kind = 'actionable' OR status IN ('todo','waiting','skipped','archived'))
);

CREATE TABLE subtask_estimate (                    -- 预估修订历史
  id          TEXT PRIMARY KEY NOT NULL,
  subtask_id  TEXT NOT NULL REFERENCES subtask(id) ON DELETE CASCADE,
  minutes     INTEGER NOT NULL CHECK (minutes >= 0),
  source      TEXT NOT NULL CHECK (source IN ('ai','confirmed','revised')),
  at          INTEGER NOT NULL
);

CREATE TABLE subtask_dep (                         -- pre 完成后 post 才能开始
  pre_id   TEXT NOT NULL REFERENCES subtask(id) ON DELETE CASCADE,
  post_id  TEXT NOT NULL REFERENCES subtask(id) ON DELETE CASCADE,
  active   INTEGER NOT NULL DEFAULT 1,             -- 细化后被替换的旧边置 0
  PRIMARY KEY (pre_id, post_id),
  CHECK (pre_id <> post_id)
);

CREATE TABLE plan_block (                          -- 计划时间块，允许任意重叠
  id             TEXT PRIMARY KEY NOT NULL,
  subtask_id     TEXT NOT NULL REFERENCES subtask(id) ON DELETE CASCADE,
  start_at       INTEGER NOT NULL,
  end_at         INTEGER NOT NULL,
  tz_offset_min  INTEGER NOT NULL,
  locked         INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL CHECK (source IN ('ai','manual')),
  state          TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (end_at > start_at)
);

CREATE TABLE work_session (                        -- 实际工作记录，实际耗时的唯一来源
  id                  TEXT PRIMARY KEY NOT NULL,
  subtask_id          TEXT NOT NULL REFERENCES subtask(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('timer','range','duration')),
  start_at            INTEGER,                     -- duration 类为空
  end_at              INTEGER,                     -- 计时中为空
  duration_ms         INTEGER,                     -- 仅 duration 类
  local_date          TEXT,                        -- 仅 duration 类：归属日期
  tz_offset_min       INTEGER NOT NULL,
  last_alive_at       INTEGER,                     -- 计时中由心跳更新
  plan_block_id       TEXT REFERENCES plan_block(id) ON DELETE SET NULL,
  intensity_snapshot  INTEGER CHECK (intensity_snapshot BETWEEN 1 AND 5),
  origin              TEXT NOT NULL CHECK (origin IN ('timer','manual','gap_confirmed')),
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (
    (kind = 'duration' AND start_at IS NULL AND end_at IS NULL
       AND duration_ms IS NOT NULL AND duration_ms >= 0 AND local_date IS NOT NULL)
    OR (kind = 'range' AND start_at IS NOT NULL AND end_at IS NOT NULL AND end_at > start_at)
    OR (kind = 'timer' AND start_at IS NOT NULL AND (end_at IS NULL OR end_at > start_at))
  )
);

CREATE TABLE timer (                               -- 计时器状态；无记录 = 停止
  subtask_id       TEXT PRIMARY KEY NOT NULL REFERENCES subtask(id) ON DELETE CASCADE,
  state            TEXT NOT NULL CHECK (state IN ('running','paused')),
  open_session_id  TEXT REFERENCES work_session(id),
  interrupted_at   INTEGER,                        -- 退出或崩溃时写入，重开后提示
  updated_at       INTEGER NOT NULL,
  CHECK ((state = 'running') = (open_session_id IS NOT NULL))
);

CREATE TABLE timer_gap (                           -- 待确认是否计入的时段
  id          TEXT PRIMARY KEY NOT NULL,
  subtask_id  TEXT NOT NULL REFERENCES subtask(id) ON DELETE CASCADE,
  start_at    INTEGER NOT NULL,
  end_at      INTEGER,                             -- 退出类在重开时补全
  cause       TEXT NOT NULL CHECK (cause IN ('sleep','quit','crash','clock_jump')),
  decision    TEXT NOT NULL DEFAULT 'pending'
              CHECK (decision IN ('pending','counted','discarded')),
  session_id  TEXT REFERENCES work_session(id),    -- 计入时生成的工作记录
  decided_at  INTEGER
);

CREATE TABLE completion_event (                    -- 主任务的一次完成
  id             TEXT PRIMARY KEY NOT NULL,
  task_id        TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  completed_at   INTEGER NOT NULL,
  tz_offset_min  INTEGER NOT NULL,
  local_date     TEXT NOT NULL,                    -- 评分与完成数都归属这一天
  reopened_at    INTEGER,                          -- M2：被重开后不再是当前完成
  intensity      INTEGER CHECK (intensity BETWEEN 1 AND 5),
  mood           INTEGER CHECK (mood BETWEEN 1 AND 5),
  rated_at       INTEGER,                          -- 两项分数都填后写入
  review         TEXT,
  note           TEXT
);

CREATE TABLE unavailable_time (                    -- 日历背景，不限制排程
  id             TEXT PRIMARY KEY NOT NULL,
  start_at       INTEGER NOT NULL,
  end_at         INTEGER NOT NULL,
  tz_offset_min  INTEGER NOT NULL,
  repeat_rule    TEXT CHECK (repeat_rule IS NULL OR json_valid(repeat_rule)),
  note           TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (end_at > start_at)
);

CREATE TABLE daily_record (
  local_date  TEXT PRIMARY KEY NOT NULL,
  energy      INTEGER CHECK (energy  BETWEEN 1 AND 5),   -- M3
  sleep       INTEGER CHECK (sleep   BETWEEN 1 AND 5),   -- M3
  fatigue     INTEGER CHECK (fatigue BETWEEN 1 AND 5),   -- M3
  summary     TEXT,
  checkin_at  INTEGER,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE ai_request (                          -- 每次调用的完整记录
  id              TEXT PRIMARY KEY NOT NULL,
  kind            TEXT NOT NULL,
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  request_json    TEXT NOT NULL,
  response_json   TEXT,
  status          TEXT NOT NULL CHECK (status IN ('ok','invalid','error','blocked')),
  error           TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  latency_ms      INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE ai_draft (
  id          TEXT PRIMARY KEY NOT NULL,
  kind        TEXT NOT NULL,                       -- split / refine / schedule / reschedule …
  task_id     TEXT REFERENCES task(id) ON DELETE CASCADE,
  request_id  TEXT REFERENCES ai_request(id),
  base_revs   TEXT NOT NULL CHECK (json_valid(base_revs)),  -- {"calendar":41,"task:<id>":3}
  payload     TEXT NOT NULL CHECK (json_valid(payload)),    -- 通过校验的 AI 原始输出
  status      TEXT NOT NULL CHECK (status IN ('open','applied','discarded','stale')),
  created_at  INTEGER NOT NULL,
  closed_at   INTEGER
);

CREATE TABLE draft_edit (                          -- 核对时的逐项修改，学习信号
  id        TEXT PRIMARY KEY NOT NULL,
  draft_id  TEXT NOT NULL REFERENCES ai_draft(id) ON DELETE CASCADE,
  path      TEXT NOT NULL,                         -- 如 subtasks[t3].est_min
  before    TEXT,
  after     TEXT,
  at        INTEGER NOT NULL
);

CREATE TABLE change_event (                        -- 审计与学习，只追加
  id         TEXT PRIMARY KEY NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  action     TEXT NOT NULL,
  before     TEXT,
  after      TEXT,
  source     TEXT NOT NULL CHECK (source IN ('user','ai_draft','system')),
  draft_id   TEXT,
  meta       TEXT,                                 -- 如拖动意图 {"intent":"once"}
  at         INTEGER NOT NULL
);

CREATE TABLE app_rev (                             -- 全局修订号，AI 草稿据此判断是否过期
  scope  TEXT PRIMARY KEY NOT NULL,                -- 'calendar'
  rev    INTEGER NOT NULL
);

CREATE TABLE backup_log (
  id          TEXT PRIMARY KEY NOT NULL,
  path        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('daily','manual','pre_delete','pre_migration','pre_restore')),
  size_bytes  INTEGER,
  check_ok    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE setting (
  key    TEXT PRIMARY KEY NOT NULL,
  value  TEXT NOT NULL CHECK (json_valid(value))
);

CREATE INDEX idx_task_lifecycle   ON task(lifecycle) WHERE deleted_at IS NULL;
CREATE INDEX idx_subtask_task     ON subtask(task_id);
CREATE INDEX idx_dep_post         ON subtask_dep(post_id) WHERE active = 1;
CREATE INDEX idx_block_time       ON plan_block(start_at, end_at) WHERE state = 'active';
CREATE INDEX idx_block_subtask    ON plan_block(subtask_id);
CREATE INDEX idx_session_subtask  ON work_session(subtask_id);
CREATE INDEX idx_session_time     ON work_session(start_at, end_at);
CREATE INDEX idx_session_date     ON work_session(local_date) WHERE kind = 'duration';
CREATE UNIQUE INDEX uq_open_timer ON work_session(subtask_id) WHERE kind = 'timer' AND end_at IS NULL;
CREATE INDEX idx_completion_task  ON completion_event(task_id);
CREATE INDEX idx_completion_date  ON completion_event(local_date) WHERE reopened_at IS NULL;
CREATE INDEX idx_change_entity    ON change_event(entity, entity_id, at);

-- 主任务的待办 / 进行中由子任务推导，不单独存
CREATE VIEW v_task_status AS
SELECT t.id,
       CASE
         WHEN t.lifecycle <> 'active' THEN t.lifecycle
         WHEN EXISTS (
           SELECT 1 FROM subtask s
           WHERE s.task_id = t.id
             AND (s.status = 'done'
                  OR EXISTS (SELECT 1 FROM work_session w WHERE w.subtask_id = s.id))
         ) THEN 'in_progress'
         ELSE 'todo'
       END AS status
FROM task t
WHERE t.deleted_at IS NULL;

INSERT INTO app_rev (scope, rev) VALUES ('calendar', 0);
