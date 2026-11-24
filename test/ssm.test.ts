import assert from 'node:assert/strict';
import test from 'node:test';
import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import { ssmParameterReader } from '../src/ssm.ts';

function fakeClient(respond: (command: GetParameterCommand) => unknown) {
  const client = new SSMClient({ region: 'eu-west-2' });
  const commands: GetParameterCommand[] = [];
  client.send = (async (command: GetParameterCommand) => {
    commands.push(command);
    return respond(command);
  }) as SSMClient['send'];
  return { client, commands };
}

test('reads the parameter with decryption', async () => {
  const { client, commands } = fakeClient(() => ({ Parameter: { Value: 'value' } }));
  const read = ssmParameterReader(client);
  assert.equal(await read('/app/secret'), 'value');
  assert.ok(commands[0] instanceof GetParameterCommand);
  assert.deepEqual(commands[0].input, { Name: '/app/secret', WithDecryption: true });
});

test("reports a parameter that doesn't exist clearly", async () => {
  const { client } = fakeClient(() => {
    throw new ParameterNotFound({ message: 'not found', $metadata: {} });
  });
  await assert.rejects(ssmParameterReader(client)('/app/missing'), {
    message: "the parameter doesn't exist",
  });
});

test('passes other errors on', async () => {
  const { client } = fakeClient(() => {
    throw Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' });
  });
  await assert.rejects(ssmParameterReader(client)('/app/secret'), {
    name: 'AccessDeniedException',
  });
});

test('fails on a parameter without a value', async () => {
  const { client } = fakeClient(() => ({ Parameter: {} }));
  await assert.rejects(ssmParameterReader(client)('/app/secret'), {
    message: 'the parameter has no value',
  });
});
