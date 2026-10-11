import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SPLIT_TOOLS } from './split/schema';
import { strictTool, strictViolations, strictify } from './strict-schema';

describe('strictify：转成 DeepSeek strict 模式接受的 JSON Schema', () => {
  it('所有属性都进 required，对象一律 additionalProperties: false', () => {
    const t = strictTool('f', 'd', z.object({ a: z.string(), b: z.string().optional(), c: z.object({ d: z.number() }) }));
    const p = t.function.parameters;
    expect(p.required).toEqual(['a', 'b', 'c']);
    expect(p.additionalProperties).toBe(false);
    expect((p.properties as Record<string, { additionalProperties: unknown }>).c?.additionalProperties).toBe(false);
  });

  it('剥掉不支持的长度和数量约束，保留数值范围与枚举', () => {
    const t = strictTool(
      'f',
      'd',
      z.object({ s: z.string().min(1).max(9), a: z.array(z.string()).min(2).max(3), n: z.number().int().min(5).max(600), e: z.enum(['x', 'y']) }),
    );
    const props = t.function.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.s).toEqual({ type: 'string' });
    expect(props.a).toEqual({ type: 'array', items: { type: 'string' } });
    expect(props.n).toMatchObject({ type: 'integer', minimum: 5, maximum: 600 });
    expect(props.e).toMatchObject({ type: 'string', enum: ['x', 'y'] });
    expect(t.function.parameters).not.toHaveProperty('$schema');
  });

  it('默认拒绝 nullable；探测模式下转成 anyOf', () => {
    const s = z.object({ x: z.string().nullable().describe('可空') });
    expect(() => strictTool('f', 'd', s)).toThrow(/nullable/);
    const t = strictTool('f', 'd', s, { nullable: 'anyOf' });
    expect((t.function.parameters.properties as Record<string, unknown>).x).toEqual({
      description: '可空',
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
  });

  it('拒绝 strict 模式不支持的开放对象', () => {
    expect(() => strictTool('f', 'd', z.object({ m: z.record(z.string(), z.string()) }))).toThrow(/开放的对象/);
  });

  it('不支持的 format 被去掉', () => {
    expect(strictify({ type: 'string', format: 'date-time' })).toEqual({ type: 'string' });
    expect(strictify({ type: 'string', format: 'uuid' })).toEqual({ type: 'string', format: 'uuid' });
  });

  it('拆分请求的两个工具完全符合 strict 规则', () => {
    for (const t of SPLIT_TOOLS) {
      expect(t.function.strict).toBe(true);
      expect(strictViolations(t.function.parameters), t.function.name).toEqual([]);
    }
  });

  it('strictViolations 能发现违规', () => {
    expect(strictViolations({ type: 'object', properties: { a: { type: 'string', maxLength: 3 } } })).toEqual([
      '$：additionalProperties 必须为 false',
      '$.a：没有列在 required 里',
      '$.a：含不支持的关键字 maxLength',
    ]);
  });
});
