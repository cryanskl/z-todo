import type { ViewId } from '../nav';
import { VIEWS } from '../nav';

/** 尚未实现的视图：说明它将承载什么、在哪一步实现，对应技术方案「M1 实施计划」。 */
const PLANS: Record<Exclude<ViewId, 'settings'>, { purpose: string; items: string[]; step: string }> = {
  review: {
    purpose: '新建任务、处理收集箱，审核 AI 的拆分与排程草稿后确认入库。',
    items: ['输入主任务，选择拆分粒度或不拆分', 'AI 追问（每轮 2–3 个问题，最多两轮）', '以 diff 核对子任务、依赖、预估、时间块', '草稿过期时重新生成，不覆盖你的修改'],
    step: 'M1 第 7 步',
  },
  today: {
    purpose: '每天的执行入口：今天要做的子任务、计时、直接完成与补记。',
    items: ['今日子任务与每个主任务的下一步', '开始 / 暂停 / 继续 / 完成计时，可并发', '直接完成时补记时间区间或时长', '计划投入与计划占用分开显示'],
    step: 'M1 第 5 步',
  },
  calendar: {
    purpose: '周视图与日视图，时间块允许任意重叠，并排显示。',
    items: ['主任务跨度横条与子任务时间块', '拖动、缩放、锁定时间块', '不可用时间作为背景', '依赖未满足的时间块标红'],
    step: 'M1 第 6 步',
  },
  history: {
    purpose: '回看已完成和放弃的任务，查看耗时、评分、复盘与基础统计。',
    items: ['按时间、分类、标签筛选', '预估与实际对比，未知耗时显示「未记录」', '待补评分的任务', '按分类的投入与可确认占用'],
    step: 'M1 第 5 步',
  },
};

export function PlannedView({ view }: { view: Exclude<ViewId, 'settings'> }) {
  const meta = VIEWS.find((v) => v.id === view)!;
  const plan = PLANS[view];
  return (
    <section className="mx-auto max-w-2xl px-10 py-10">
      <h1 className="text-xl font-semibold tracking-tight">{meta.label}</h1>
      <p className="mt-2 text-sm leading-relaxed text-stone-600 dark:text-stone-400">{plan.purpose}</p>

      <div className="mt-8 rounded-xl border border-dashed border-stone-300 bg-white/60 p-6 dark:border-stone-700 dark:bg-stone-900/40">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">这里将会有</h2>
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent dark:bg-stone-800 dark:text-stone-300">
            {plan.step}
          </span>
        </div>
        <ul className="mt-4 space-y-2 text-sm text-stone-600 dark:text-stone-400">
          {plan.items.map((item) => (
            <li key={item} className="flex gap-2">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-stone-400" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
