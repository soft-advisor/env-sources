import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { createResolver, EnvSourcesError, fromSsmParameter } from '../src/index.ts';
import type { StandardSchemaV1 } from '../src/standard-schema.ts';

const SECRET = 's3cret-value-that-must-never-appear-in-errors';

function fakeParameters(parameters: Record<string, string>) {
  const reads: string[] = [];
  const readSsmParameter = async (name: string) => {
    reads.push(name);
    const value = parameters[name];
    if (value === undefined) throw new Error("the parameter doesn't exist");
    return value;
  };
  return { reads, readSsmParameter };
}

async function resolveError(promise: Promise<unknown>) {
  const error = await promise.then(
    () => assert.fail('expected resolve to fail'),
    (error: unknown) => error,
  );
  assert.ok(error instanceof EnvSourcesError);
  assert.ok(!error.message.includes(SECRET), 'the error must not contain values');
  return error;
}

test('resolves literal values', async () => {
  const resolver = createResolver();
  const schema = z.object({ APP_ENV: z.enum(['dev', 'production']), REGION: z.string() });
  const env = await resolver.resolve(schema, { APP_ENV: 'dev', REGION: 'eu-west-2' });
  assert.deepEqual(env, { APP_ENV: 'dev', REGION: 'eu-west-2' });
});

test('leaves undefined values out, so optional variables can be unset', async () => {
  const resolver = createResolver();
  const schema = z.object({ APP_ENV: z.string(), SENTRY_DSN: z.string().optional() });
  const env = await resolver.resolve(schema, { APP_ENV: 'dev', SENTRY_DSN: undefined });
  assert.deepEqual(env, { APP_ENV: 'dev' });
  assert.ok(!('SENTRY_DSN' in env));
});

test('fails when a required value is undefined', async () => {
  const resolver = createResolver();
  const schema = z.object({ SENTRY_AUTH_TOKEN: z.string() });
  const error = await resolveError(resolver.resolve(schema, { SENTRY_AUTH_TOKEN: undefined }));
  assert.equal(error.problems.length, 1);
  assert.match(error.problems[0], /^SENTRY_AUTH_TOKEN: /);
});

test('reads whole parameters and fields of JSON parameters', async () => {
  const { readSsmParameter } = fakeParameters({
    '/app/session-secret': SECRET,
    '/app/alpha': JSON.stringify({ emails: 'a@example.com,b@example.com', other: 'unused' }),
  });
  const resolver = createResolver({ readSsmParameter });
  const schema = z.object({ SESSION_SECRET: z.string().min(32), ALPHA_EMAILS: z.string() });
  const env = await resolver.resolve(schema, {
    SESSION_SECRET: fromSsmParameter('/app/session-secret'),
    ALPHA_EMAILS: fromSsmParameter('/app/alpha', 'emails'),
  });
  assert.deepEqual(env, { SESSION_SECRET: SECRET, ALPHA_EMAILS: 'a@example.com,b@example.com' });
});

test('passes a field holding an object on as JSON, and returns strings, not the parsed output', async () => {
  const api = { url: 'https://api.example.com', basicAuth: { username: 'app', password: SECRET } };
  const { readSsmParameter } = fakeParameters({ '/app/partner': JSON.stringify({ api }) });
  const resolver = createResolver({ readSsmParameter });
  const apiSchema = z.object({
    url: z.url(),
    basicAuth: z.object({ username: z.string(), password: z.string() }),
  });
  const schema = z.object({
    PARTNER_API: z
      .string()
      .transform((json) => JSON.parse(json))
      .pipe(apiSchema),
  });
  const env = await resolver.resolve(schema, {
    PARTNER_API: fromSsmParameter('/app/partner', 'api'),
  });
  assert.equal(typeof env.PARTNER_API, 'string');
  assert.deepEqual(JSON.parse(env.PARTNER_API), api);
});

test('reads each parameter once per resolver, across variables and resolve calls', async () => {
  const { reads, readSsmParameter } = fakeParameters({
    '/shared/sentry': JSON.stringify({ dsn: 'https://key@sentry.example/1', authToken: SECRET }),
  });
  const resolver = createResolver({ readSsmParameter });
  await resolver.resolve(z.object({ SENTRY_DSN: z.string(), SENTRY_AUTH_TOKEN: z.string() }), {
    SENTRY_DSN: fromSsmParameter('/shared/sentry', 'dsn'),
    SENTRY_AUTH_TOKEN: fromSsmParameter('/shared/sentry', 'authToken'),
  });
  await resolver.resolve(z.object({ NEXT_PUBLIC_SENTRY_DSN: z.string() }), {
    NEXT_PUBLIC_SENTRY_DSN: fromSsmParameter('/shared/sentry', 'dsn'),
  });
  assert.deepEqual(reads, ['/shared/sentry']);
});

test('reports every problem at once, without values', async () => {
  const { readSsmParameter } = fakeParameters({
    '/app/not-json': SECRET,
    '/app/array': JSON.stringify([SECRET]),
    '/app/config': JSON.stringify({ present: SECRET, empty: null }),
  });
  const resolver = createResolver({ readSsmParameter });
  const schema = z.object({
    MISSING_PARAMETER: z.string(),
    NOT_JSON: z.string(),
    NOT_AN_OBJECT: z.string(),
    MISSING_FIELD: z.string(),
    NULL_FIELD: z.string(),
    TOO_SHORT: z.string().min(100),
  });
  const error = await resolveError(
    resolver.resolve(schema, {
      MISSING_PARAMETER: fromSsmParameter('/app/missing'),
      NOT_JSON: fromSsmParameter('/app/not-json', 'field'),
      NOT_AN_OBJECT: fromSsmParameter('/app/array', 'field'),
      MISSING_FIELD: fromSsmParameter('/app/config', 'absent'),
      NULL_FIELD: fromSsmParameter('/app/config', 'empty'),
      TOO_SHORT: fromSsmParameter('/app/config', 'present'),
    }),
  );
  const problemFor = (key: string) => error.problems.filter((problem) => problem.startsWith(key));
  assert.match(problemFor('MISSING_PARAMETER')[0], /couldn't read \/app\/missing: .*doesn't exist/);
  assert.match(problemFor('NOT_JSON')[0], /\/app\/not-json isn't valid JSON/);
  assert.match(problemFor('NOT_AN_OBJECT')[0], /\/app\/array isn't a JSON object/);
  assert.match(problemFor('MISSING_FIELD')[0], /\/app\/config has no field "absent"/);
  assert.match(problemFor('NULL_FIELD')[0], /\/app\/config has no field "empty"/);
  assert.equal(problemFor('TOO_SHORT').length, 1);
});

test('fails clearly when a parameter is used without readSsmParameter', async () => {
  const resolver = createResolver();
  const error = await resolveError(
    resolver.resolve(z.object({ SECRET: z.string() }), { SECRET: fromSsmParameter('/app/secret') }),
  );
  assert.match(error.problems[0], /^SECRET: .*needs `readSsmParameter`/);
});

test('works with any Standard Schema, including asynchronous validation', async () => {
  const schema: StandardSchemaV1<{ PORT: string }> = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: async (value) => {
        const port = (value as { PORT?: string }).PORT;
        if (port && /^\d+$/.test(port)) return { value: { PORT: port } };
        return { issues: [{ message: 'must be a number', path: [{ key: 'PORT' }] }] };
      },
    },
  };
  const resolver = createResolver();
  assert.deepEqual(await resolver.resolve(schema, { PORT: '3000' }), { PORT: '3000' });
  const error = await resolveError(resolver.resolve(schema, { PORT: 'abc' }));
  assert.deepEqual(error.problems, ['PORT: must be a number']);
});

test('types: required keys must be mapped, optional ones may be left out, unknown ones are rejected', async () => {
  const resolver = createResolver();
  const schema = z.object({ REQUIRED: z.string(), OPTIONAL: z.string().optional() });
  await resolver.resolve(schema, { REQUIRED: 'value' });
  // @ts-expect-error REQUIRED isn't mapped
  await resolver.resolve(schema, { OPTIONAL: 'value' }).catch(() => undefined);
  // @ts-expect-error UNKNOWN isn't in the schema
  await resolver.resolve(schema, { REQUIRED: 'value', UNKNOWN: 'value' });
  // @ts-expect-error values are strings or sources, never numbers
  await resolver.resolve(schema, { REQUIRED: 3000 }).catch(() => undefined);
});
