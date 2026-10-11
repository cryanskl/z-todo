/**
 * 把 Zod schema 转成 DeepSeek strict 工具调用接受的 JSON Schema。
 *
 * DeepSeek strict 模式的限制（https://api-docs.deepseek.com/zh-cn/guides/tool_calls）：
 * - 支持 object、string、number、integer、boolean、array、enum、anyOf；
 * - 每个 object 的所有属性都必须在 required 里，additionalProperties 必须为 false；
 * - string 不支持 minLength、maxLength；array 不支持 minItems、maxItems；
 * - string 的 format 只支持 email、hostname、ipv4、ipv6、uuid。
 *
 * 被剥掉的约束（长度、数量）由本地 Zod 校验兜底，所以同一个 Zod schema 既生成工具定义，
 * 又校验模型输出。
 */

import { z } from 'zod';

export type JsonSchema = { [key: string]: unknown };

export interface StrictifyOptions {
  /**
   * 可空字段的处理：
   * - 'reject'（默认）：直接报错。AI 用的 schema 不使用 null，「没有」用空字符串表示。
   * - 'anyOf'：转成 anyOf [类型, {type: 'null'}]，仅用于探测 DeepSeek 是否支持。
   */
  nullable?: 'reject' | 'anyOf';
}

const DROP_KEYS = new Set(['$schema', 'minLength', 'maxLength', 'minItems', 'maxItems', 'default', 'examples']);
const SUPPORTED_FORMATS = new Set(['email', 'hostname', 'ipv4', 'ipv6', 'uuid']);

export function strictify(schema: JsonSchema, opts: StrictifyOptions = {}, path = '$'): JsonSchema {
  const nullable = opts.nullable ?? 'reject';
  const out: JsonSchema = {};

  for (const [k, v] of Object.entries(schema)) {
    if (DROP_KEYS.has(k)) continue;
    if (k === 'format' && !SUPPORTED_FORMATS.has(String(v))) continue;
    out[k] = v;
  }

  if ('oneOf' in out) {
    out.anyOf = out.oneOf;
    delete out.oneOf;
  }
  if ('const' in out && typeof out.const === 'string') {
    out.enum = [out.const];
    delete out.const;
  }

  if (Array.isArray(out.type)) {
    const types = out.type as string[];
    const nonNull = types.filter((t) => t !== 'null');
    if (nonNull.length !== 1) throw new Error(`${path}：不支持多类型 ${JSON.stringify(types)}`);
    if (types.includes('null')) {
      if (nullable === 'reject') {
        throw new Error(`${path}：AI 用的 schema 不要用 nullable，「没有」请用空字符串或空数组表示`);
      }
      const { description, ...rest } = out;
      const inner = strictify({ ...rest, type: nonNull[0] }, opts, path);
      return description === undefined
        ? { anyOf: [inner, { type: 'null' }] }
        : { description, anyOf: [inner, { type: 'null' }] };
    }
    out.type = nonNull[0];
  }

  if (out.type === 'object') {
    if (out.additionalProperties !== undefined && out.additionalProperties !== false) {
      throw new Error(`${path}：strict 模式不支持开放的对象（record / passthrough）`);
    }
    const props = (out.properties ?? {}) as Record<string, JsonSchema>;
    out.properties = Object.fromEntries(
      Object.entries(props).map(([name, s]) => [name, strictify(s, opts, `${path}.${name}`)]),
    );
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }

  if (out.type === 'array' && out.items) {
    if (Array.isArray(out.items)) throw new Error(`${path}：不支持元组`);
    out.items = strictify(out.items as JsonSchema, opts, `${path}[]`);
  }

  if (Array.isArray(out.anyOf)) {
    out.anyOf = (out.anyOf as JsonSchema[]).map((s, i) => strictify(s, opts, `${path}|${i}`));
  }

  return out;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    strict: true;
    parameters: JsonSchema;
  };
}

export function strictTool(
  name: string,
  description: string,
  schema: z.ZodType,
  opts?: StrictifyOptions,
): ToolDefinition {
  // io: 'input' 让带默认值或变换的字段按「模型要提供的形状」生成
  const json = z.toJSONSchema(schema, { io: 'input' }) as JsonSchema;
  return { type: 'function', function: { name, description, strict: true, parameters: strictify(json, opts) } };
}

/** 检查 schema 是否满足 DeepSeek strict 模式的全部规则，返回违规路径列表。测试与探测用。 */
export function strictViolations(schema: JsonSchema, path = '$'): string[] {
  const problems: string[] = [];
  const allowedTypes = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array', 'null']);
  for (const k of Object.keys(schema)) {
    if (DROP_KEYS.has(k)) problems.push(`${path}：含不支持的关键字 ${k}`);
  }
  if ('format' in schema && !SUPPORTED_FORMATS.has(String(schema.format))) {
    problems.push(`${path}：不支持的 format ${String(schema.format)}`);
  }
  if (schema.type !== undefined && (typeof schema.type !== 'string' || !allowedTypes.has(schema.type))) {
    problems.push(`${path}：不支持的 type ${JSON.stringify(schema.type)}`);
  }
  if (schema.type === 'object') {
    const props = Object.keys((schema.properties ?? {}) as object);
    const required = (schema.required ?? []) as string[];
    if (schema.additionalProperties !== false) problems.push(`${path}：additionalProperties 必须为 false`);
    for (const p of props) if (!required.includes(p)) problems.push(`${path}.${p}：没有列在 required 里`);
    for (const [p, s] of Object.entries((schema.properties ?? {}) as Record<string, JsonSchema>)) {
      problems.push(...strictViolations(s, `${path}.${p}`));
    }
  }
  if (schema.type === 'array' && schema.items) problems.push(...strictViolations(schema.items as JsonSchema, `${path}[]`));
  if (Array.isArray(schema.anyOf)) {
    (schema.anyOf as JsonSchema[]).forEach((s, i) => problems.push(...strictViolations(s, `${path}|${i}`)));
  }
  return problems;
}
