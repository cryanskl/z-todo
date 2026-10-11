# z-todo：给 Coding Agent 的工作说明

产品规则以需求文档为准，实现方式以技术方案为准；两者冲突时以需求文档为准，并先回到文档修改。

- 需求文档：<https://claude.ai/code/artifact/7a9aa2c2-720c-4830-85b4-35509aed3f8e>
- 技术方案：<https://claude.ai/code/artifact/f7852a18-ed18-4f8b-a190-de3d6ffd1a1e>

## 架构规则

1. **业务规则只写在 `packages/core`**，且必须是纯函数：不读写数据库、不发请求、不读系统时钟（「现在」作为参数传入）。ESLint 会拦截违规导入。
2. **源记录是唯一事实**：计时段、补记、时间块、完成事件、每日记录。统计一律从源记录现算，缓存可以丢弃重建。
3. **写操作 = 一个事务计划**：读取 → 纯函数计算 → 生成 `TxPlan` → `host.tx` 原子提交。可变表更新写成 `... SET version = version + 1 WHERE id = ? AND version = ?` 并带 `expectChanges: 1`；改动时间块或不可用时间时同一事务里把 `app_rev.calendar` 加一。
4. **AI 只写草稿**：模型输出先进 `ai_draft`，用户确认后由本地代码写正式表；确认前检查 `base_revs`。
5. **时间存 UTC 毫秒**，同时存写入时的 `tz_offset_min`；归属日期用 `@z-todo/core` 的 `localDateOf`。
6. **缺失值不伪造**：未知耗时不是 0，未评分不是 0 分也不是 3 分。

## 数据库

- 迁移 SQL 在 `apps/desktop/src-tauri/db/migrations/`，Rust 与 TypeScript 共用。新增迁移：放一个新文件 `000N_xxx.sql`，并在 `zt-db` 的 `MIGRATIONS` 里登记（有测试检查两边一致）。
- `0001_init.sql` 在第一个日常使用版本发布前可以直接修改；发布后只能新增迁移，不能改旧文件。
- 改了表结构，同步改 `apps/desktop/src/db/schema.ts`；`schema-drift.test.ts` 会逐列比对。
- 文本主键一律 `NOT NULL`（SQLite 的 TEXT 主键默认允许 NULL）。
- 迁移脚本里不要写 `PRAGMA foreign_keys`：执行器在事务外关闭外键（否则重建表会级联删除子表数据），事务内跑完脚本后用 `foreign_key_check` 检查，有违规整体回滚；升级前自动备份。
- `query` 和 `tx` 拒绝事务控制（BEGIN、COMMIT、SAVEPOINT 等）、ATTACH/DETACH、VACUUM、REINDEX、ANALYZE、EXPLAIN；查询里只允许读取型 PRAGMA，事务计划里不允许任何 PRAGMA。名单在 `zt-db` 的 `forbidden` 与 `src/host/sql-text.ts`，两边保持一致。
- 触发器里 `RAISE(ABORT, '...')` 的信息必须包含 `constraint failed`（例如 `'constraint failed: 子任务不能再有子任务'`）。Rust 按错误码归类，sql.js 只能看信息文字，这样两个宿主才会都返回 `constraint`。

## 宿主端口

- `src/host/types.ts` 的形状与 Rust 命令一一对应；改一边必须改另一边。
- 新增宿主行为时，先在 `tests/fixtures/host-smoke.json` 加场景，再让 `pnpm test` 与 `pnpm test:rust` 都通过。

## AI

- 工具定义用 `strictTool(name, description, zodSchema)` 生成；同一个 Zod schema 也用于校验输出。
- AI 用的 schema 不使用 null（DeepSeek strict 模式未声明支持），「没有」用空字符串或空数组。
- 提示词在 `src/ai/prompts/*.vN.ts`，改文字就升版本；系统提示词保持不变才能命中前缀缓存。
- 标记为「不发送 AI」的任务及其历史不得进入任何请求。

## 测试

- 需求文档「验收场景」里的每一条对应一个用例，用例名直接用场景原文，放在 `tests/acceptance/`（按章节分文件）。
- 纯函数优先写属性测试（fast-check）。
- 提交前：`pnpm lint && pnpm typecheck && pnpm test && pnpm test:rust`；改了 Rust 再跑 `cargo fmt --all`（在 `apps/desktop/src-tauri` 下，CI 会检查格式）。

## 界面

- 界面文字、提示词、注释都用中文；代码标识符用英文。
- 组件里不写业务规则，只调用查询和命令。
