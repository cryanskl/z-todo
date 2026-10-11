/**
 * 依赖图环检测（Kahn 拓扑排序，O(V + E)）。
 * 依赖语义：pre 完成后 post 才能开始。
 */

export interface DepEdge {
  pre: string;
  post: string;
}

/**
 * 返回一个环上的节点（按依赖方向排列，首尾相接），无环时返回 null。
 * 不在 nodes 里的端点视为图的一部分，避免遗漏草稿里的悬空引用造成的环。
 */
export function findCycle(nodes: readonly string[], edges: readonly DepEdge[]): string[] | null {
  const all = new Set(nodes);
  for (const e of edges) {
    all.add(e.pre);
    all.add(e.post);
  }

  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of all) {
    out.set(n, []);
    inn.set(n, []);
    indeg.set(n, 0);
  }
  for (const e of edges) {
    out.get(e.pre)!.push(e.post);
    inn.get(e.post)!.push(e.pre);
    indeg.set(e.post, indeg.get(e.post)! + 1);
  }

  const queue: string[] = [];
  for (const [n, d] of indeg) if (d === 0) queue.push(n);
  let seen = 0;
  while (queue.length > 0) {
    const n = queue.shift()!;
    seen++;
    for (const m of out.get(n)!) {
      const d = indeg.get(m)! - 1;
      indeg.set(m, d);
      if (d === 0) queue.push(m);
    }
  }
  if (seen === all.size) return null;

  // 剩余节点在环上或在环的下游，但每个剩余节点至少有一个前置也在剩余集合里
  // （它的入度还没减到 0）。所以沿「前置」往回走必然回到走过的节点，得到一个环。
  const remaining = new Set([...indeg].filter(([, d]) => d > 0).map(([n]) => n));
  const start = remaining.values().next().value as string;
  const back: string[] = [];
  const index = new Map<string, number>();
  let cur = start;
  while (!index.has(cur)) {
    index.set(cur, back.length);
    back.push(cur);
    cur = inn.get(cur)!.find((p) => remaining.has(p))!;
  }
  return back.slice(index.get(cur)!).reverse();
}
