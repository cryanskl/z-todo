# z-todo

会拆分任务的个人待办，macOS 桌面应用。AI 把主任务拆成子任务并给出排程建议，你核对、执行、复盘；数据只存在本机。

- 需求文档：<https://claude.ai/code/artifact/7a9aa2c2-720c-4830-85b4-35509aed3f8e>
- 技术方案：<https://claude.ai/code/artifact/f7852a18-ed18-4f8b-a190-de3d6ffd1a1e>

## 进度

| M1 步骤 | 内容 | 状态 |
| --- | --- | --- |
| 0 | DeepSeek 能力探测 | 代码完成，需要用你的 API Key 运行一次（见下文） |
| 1 | 工程骨架：Tauri + React、Rust 数据层、迁移 0001、两种宿主端口、测试与 CI | 完成 |
| 2 | 领域核心：状态机、依赖、排程校验、时长口径 | 环检测、本地日期已完成，其余待做 |
| 3–10 | 命令与查询、计时、视图、日历、AI 拆分与核对、收集箱、备份恢复、验收 | 待做 |

## 在 Mac 上运行

准备一次：

```bash
xcode-select --install                                           # Xcode 命令行工具
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
brew install node@22 && corepack enable                          # Node 22 与 pnpm（或用你习惯的方式安装）
```

然后：

```bash
pnpm install
pnpm dev          # 桌面 app（第一次编译 Rust 需要几分钟）
pnpm dev:web      # 只在浏览器里跑界面，数据在内存里，刷新即清空
pnpm build        # 打包 .app 与 .dmg，产物在 apps/desktop/src-tauri/target/release/bundle/
```

打开 app 后进「设置」填 DeepSeek API Key（存进系统钥匙串），点「测试连接」确认可用。

## 第 0 步：DeepSeek 能力探测

验证技术方案依赖的几项能力：strict 工具调用、`tool_choice` 指定函数、关闭思考模式、服务端是否真的校验 strict schema、JSON Output 备用路径，并录制第一批 AI 夹具。

```bash
DEEPSEEK_API_KEY=sk-... pnpm probe        # 默认每个用例 3 次，共 18 次调用，费用一两毛钱
pnpm probe --dry-run                      # 只打印请求体，不调用 API
```

结果写到 `tests/fixtures/ai/probe/`：`report.md` 是结论，其余是每次调用的请求与响应（不含 Key）。
结论为「通过」即可进入第 7 步按 strict 工具调用实现；不通过时报告里有失败明细。

报告的判定方式：

- 「通过三层校验」和「得到期望的结果」分开统计。信息充分时模型却选择追问，算提示词问题，单独列出，不算 strict 失败。
- 网络错误、429、5xx、服务端资源不足各重试一次，仍失败的记为「无法判断」，不计入通过率；数量多时稍后重跑即可。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm test` | TypeScript 全部测试（领域核心、宿主端口契约、Drizzle 表定义、AI 解析、探测流程） |
| `pnpm test:rust` | Rust 数据层测试（同一份宿主契约、迁移、备份） |
| `pnpm typecheck` / `pnpm lint` | 类型检查 / ESLint（含「领域核心不能做 IO」的规则） |

## 目录

```text
packages/core/                 领域核心：纯函数，无 IO
apps/desktop/
  src/host/                    宿主端口：tauri.ts（生产）、memory.ts（sql.js 测试宿主）
  src/db/                      Drizzle 表定义（只构造 SQL，执行交给宿主端口）
  src/ai/                      strict schema 转换、拆分请求、响应解析、提示词
  src/ui/                      界面
  scripts/                     DeepSeek 探测
  src-tauri/                   Rust 宿主：命令、钥匙串、DeepSeek 转发、托盘
  src-tauri/db/                zt-db：连接、迁移、备份、查询与事务（不依赖 Tauri）
  src-tauri/db/migrations/     迁移 SQL，Rust 与 TypeScript 共用
tests/fixtures/host-smoke.json 宿主端口冒烟契约，两种宿主跑同一份
```

## 两个关键设计

**同一份契约测两种宿主。** 生产环境用 Rust（rusqlite），测试和浏览器模式用 sql.js。`tests/fixtures/host-smoke.json` 里的每个场景，两边各跑一遍、结果必须一致，所以在内存宿主上跑通的业务测试，换到真实数据库也成立。

**写操作只能走事务计划。** 查询接口拒绝任何写语句；写操作是一组语句，在一个事务里执行，可以给每条语句写 `expectChanges` 做版本断言，任何一条不符整体回滚。这是需求里「AI 草稿生效前检查版本、不覆盖人工修改」的底层保证。
