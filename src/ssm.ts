import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import type { ReadSsmParameter } from './index.ts';

/**
 * Makes `readSsmParameter` for `createResolver` from an SSM client. It always decrypts, since an
 * encrypted parameter read without decryption returns its ciphertext, a string any schema would
 * accept.
 */
export function ssmParameterReader(client: SSMClient): ReadSsmParameter {
  return async (name) => {
    try {
      const command = new GetParameterCommand({ Name: name, WithDecryption: true });
      const { Parameter } = await client.send(command);
      if (Parameter?.Value === undefined) throw new Error('the parameter has no value');
      return Parameter.Value;
    } catch (error) {
      // By name rather than instanceof, which fails across copies of the SDK
      if (error instanceof Error && error.name === 'ParameterNotFound') {
        throw new Error("the parameter doesn't exist");
      }
      throw error;
    }
  };
}
