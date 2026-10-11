/**
 * DeepSeek 能力探测（M1 第 0 步）。在自己的电脑上运行：
 *
 *   DEEPSEEK_API_KEY=sk-... pnpm probe
 *   DEEPSEEK_API_KEY=sk-... pnpm probe --repeat 5 --model deepseek-flash
 *   DEEPSEEK_API_KEY=sk-... pnpm probe --only strict,enforced
 *   pnpm probe --dry-run            # 只打印请求体，不调用 API
 *
 * 检查项（--only 可选）：models、enforced、strict、nullable、json。
 * 结果写到 tests/fixtures/ai/probe/：report.md（结论）、report.json、每次调用的请求与响应（夹具）。
 * 夹具里没有 API Key；用例都是虚构任务。默认 18 次调用（失败时最多再重试 18 次），费用约 0.1–0.3 元。
 * 退出码：0 通过，2 未通过或无法得出结论。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildSplitCall } from '../src/ai/split/request';
import type { AiCall, AiResponse } from '../src/host/types';
import { buildCases, renderReport, runProbe, type Transport } from './probe/probe';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../../../tests/fixtures/ai/probe');

const { values } = parseArgs({
  options: {
    repeat: { type: 'string', default: '3' },
    model: { type: 'string', default: 'deepseek-flash' },
    only: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const nowMs = Date.now();
const tzOffsetMin = -new Date().getTimezoneOffset();

if (values['dry-run']) {
  for (const c of buildCases(nowMs, tzOffsetMin)) {
    console.log(`\n===== ${c.id}：${c.title} =====`);
    console.log(JSON.stringify(buildSplitCall(c.input, { model: values.model }).call.body, null, 2));
  }
  process.exit(0);
}

const key = process.env.DEEPSEEK_API_KEY?.trim();
if (!key) {
  console.error('请先设置环境变量 DEEPSEEK_API_KEY，例如：DEEPSEEK_API_KEY=sk-... pnpm probe');
  process.exit(1);
}

const transport: Transport = async (call: AiCall): Promise<AiResponse> => {
  const base = call.beta ? 'https://api.deepseek.com/beta' : 'https://api.deepseek.com';
  const started = Date.now();
  const res = await fetch(`${base}/${call.path}`, {
    method: call.method.toUpperCase(),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: call.method === 'post' ? JSON.stringify(call.body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, latencyMs: Date.now() - started };
};

const report = await runProbe(transport, {
  model: values.model,
  repeat: Math.max(1, Number(values.repeat) || 3),
  nowMs,
  tzOffsetMin,
  only: values.only?.split(','),
  onProgress: (line) => console.log(line),
});

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const r of report.records) {
  writeFileSync(
    join(OUT, `${r.path}-${r.caseId}-${r.attempt}.json`),
    JSON.stringify({ promptVersion: r.promptVersion, request: r.request, response: r.response ?? null, transportError: r.transportError ?? null }, null, 2) + '\n',
  );
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ ...report, records: report.records.map(({ request: _q, response: _r, ...rest }) => rest) }, null, 2) + '\n');
writeFileSync(join(OUT, 'report.md'), renderReport(report));

console.log('\n' + report.verdict.lines.join('\n'));
console.log(`\n完整报告：${join(OUT, 'report.md')}`);
process.exit(report.verdict.pass ? 0 : 2);
