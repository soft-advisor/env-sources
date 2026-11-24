import type { StandardSchemaV1 } from './standard-schema.ts';

export type { StandardSchemaV1 } from './standard-schema.ts';

// Symbol.for, so sources made by another copy of this package are still recognised
const SSM_PARAMETER = Symbol.for('@soft-advisor/env-sources/ssm-parameter');

/** A value read from an AWS Systems Manager Parameter Store parameter. Made by `fromSsmParameter`. */
export interface SsmParameterSource {
  readonly [SSM_PARAMETER]: true;
  readonly name: string;
  readonly field?: string;
}

/**
 * Where one variable's value comes from: the value itself (e.g. a literal or `process.env.X`), or
 * a parameter. `undefined` leaves the variable out, and the schema decides whether that's allowed.
 */
export type Source = string | undefined | SsmParameterSource;

/** Reads a parameter's value by name. `ssmParameterReader` from `/ssm` makes one from an SSM client. */
export type ReadSsmParameter = (name: string) => Promise<string>;

export interface ResolverOptions {
  /** Required to use `fromSsmParameter`. */
  readSsmParameter?: ReadSsmParameter;
}

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The keys an object type must have: the ones without `?`. */
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
type OptionalKeys<T> = Exclude<keyof T, RequiredKeys<T>>;

/** Every required key of the schema's input must be mapped; optional ones may be left out. */
export type Mapping<Input> = Simplify<
  { [K in RequiredKeys<Input>]: Source } & { [K in OptionalKeys<Input>]?: Source }
>;

/** The resolved variables, as strings, exactly as they should be set in an environment. */
export type ResolvedEnv<Input> = Simplify<
  { [K in RequiredKeys<Input>]: string } & { [K in OptionalKeys<Input>]?: string }
>;

/**
 * Reads the whole value of a Parameter Store parameter, or, given `field`, one top-level field of a
 * parameter that holds a JSON object. A field holding anything other than a string (an object, a
 * number) is passed on as JSON, for the schema to parse.
 */
export function fromSsmParameter(name: string, field?: string): SsmParameterSource {
  return Object.freeze({ [SSM_PARAMETER]: true as const, name, field });
}

function isSsmParameterSource(source: Source): source is SsmParameterSource {
  return typeof source === 'object' && source !== null && SSM_PARAMETER in source;
}

/** Thrown when variables can't be resolved or don't match the schema. Lists every problem. */
export class EnvSourcesError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const list = problems.map((problem) => `- ${problem}`).join('\n');
    super(`Environment variables are missing or invalid:\n${list}`);
    this.name = 'EnvSourcesError';
    this.problems = problems;
  }
}

export interface Resolver {
  /**
   * Resolves each variable from its source and validates the result with `schema`. Returns the
   * variables as strings, not the schema's output: the schema only checks them. Throws an
   * `EnvSourcesError` listing every problem, never the values.
   */
  resolve<Schema extends StandardSchemaV1>(
    schema: Schema,
    mapping: Mapping<StandardSchemaV1.InferInput<Schema>>,
  ): Promise<ResolvedEnv<StandardSchemaV1.InferInput<Schema>>>;
}

/**
 * Creates a resolver. Parameters are read once per resolver, however many variables and `resolve`
 * calls use them.
 */
export function createResolver(options: ResolverOptions = {}): Resolver {
  const parameterReads = new Map<string, Promise<string>>();

  const readParameter = (name: string) => {
    let read = parameterReads.get(name);
    if (!read) {
      read = readSsmParameter(options, name);
      parameterReads.set(name, read);
    }
    return read;
  };

  return {
    async resolve(schema, mapping) {
      const sources = Object.entries(mapping as Record<string, Source>);
      const resolved = await Promise.all(
        sources.map(([key, source]) => resolveVariable(key, source, readParameter)),
      );

      const values: Record<string, string> = {};
      const problems: string[] = [];
      for (const variable of resolved) {
        if ('problem' in variable) problems.push(variable.problem);
        else if (variable.value !== undefined) values[variable.key] = variable.value;
      }

      // Validated even when a source failed, so every problem is reported in one go
      const result = await schema['~standard'].validate(values);
      if (result.issues) problems.push(...result.issues.map(describeIssue));

      if (problems.length > 0) throw new EnvSourcesError(problems);
      return values as ResolvedEnv<StandardSchemaV1.InferInput<typeof schema>>;
    },
  };
}

async function readSsmParameter(options: ResolverOptions, name: string) {
  if (!options.readSsmParameter) {
    throw new Error('fromSsmParameter needs `readSsmParameter` in the createResolver options');
  }
  return options.readSsmParameter(name);
}

type ResolvedVariable =
  | { key: string; value: string | undefined }
  | { key: string; problem: string };

async function resolveVariable(
  key: string,
  source: Source,
  readParameter: (name: string) => Promise<string>,
): Promise<ResolvedVariable> {
  if (!isSsmParameterSource(source)) return { key, value: source };

  let parameterValue: string;
  try {
    parameterValue = await readParameter(source.name);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { key, problem: `${key}: couldn't read ${source.name}: ${reason}` };
  }
  if (source.field === undefined) return { key, value: parameterValue };
  return pickField(key, source.name, source.field, parameterValue);
}

function pickField(key: string, name: string, field: string, parameterValue: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(parameterValue);
  } catch {
    // Not the parser's message: it quotes part of the value, which may be a secret
    return { key, problem: `${key}: ${name} isn't valid JSON` };
  }

  const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  if (!isObject) return { key, problem: `${key}: ${name} isn't a JSON object` };

  const fieldValue = (parsed as Record<string, unknown>)[field];
  if (fieldValue === undefined || fieldValue === null) {
    return { key, problem: `${key}: ${name} has no field "${field}"` };
  }
  const value = typeof fieldValue === 'string' ? fieldValue : JSON.stringify(fieldValue);
  return { key, value };
}

function describeIssue(issue: StandardSchemaV1.Issue) {
  const path = (issue.path ?? [])
    .map((segment) => (typeof segment === 'object' ? segment.key : segment))
    .map(String)
    .join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}
