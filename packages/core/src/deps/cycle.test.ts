import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { findCycle, type DepEdge } from './cycle';

describe('findCycle', () => {
  it('无环返回 null', () => {
    expect(findCycle(['a', 'b', 'c'], [{ pre: 'a', post: 'b' }, { pre: 'b', post: 'c' }])).toBeNull();
    expect(findCycle([], [])).toBeNull();
  });

  it('A 依赖 B、B 又依赖 A 时找出这个环', () => {
    const cycle = findCycle(['a', 'b'], [{ pre: 'a', post: 'b' }, { pre: 'b', post: 'a' }]);
    expect(cycle).not.toBeNull();
    expect(new Set(cycle)).toEqual(new Set(['a', 'b']));
  });

  it('返回的节点首尾相接，每一步都是图里的一条边', () => {
    const edges: DepEdge[] = [
      { pre: 'x', post: 'a' },
      { pre: 'a', post: 'b' },
      { pre: 'b', post: 'c' },
      { pre: 'c', post: 'a' },
      { pre: 'c', post: 'y' },
    ];
    const cycle = findCycle(['x', 'y'], edges)!;
    const has = (p: string, q: string) => edges.some((e) => e.pre === p && e.post === q);
    cycle.forEach((n, i) => expect(has(n, cycle[(i + 1) % cycle.length]!)).toBe(true));
  });

  it('属性：只沿编号递增方向连边的图一定无环；加一条回边后一定有环', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 12 }).chain((n) =>
          fc.tuple(
            fc.constant(n),
            fc.array(fc.tuple(fc.nat(n - 1), fc.nat(n - 1)), { maxLength: 40 }),
          ),
        ),
        ([n, pairs]) => {
          const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
          const forward = pairs
            .filter(([i, j]) => i < j)
            .map(([i, j]) => ({ pre: `n${i}`, post: `n${j}` }));
          expect(findCycle(nodes, forward)).toBeNull();
          if (forward.length > 0) {
            const e = forward[0]!;
            expect(findCycle(nodes, [...forward, { pre: e.post, post: e.pre }])).not.toBeNull();
          }
        },
      ),
    );
  });
});
