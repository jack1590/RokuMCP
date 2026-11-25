import test from 'node:test';
import assert from 'node:assert/strict';
import { envHost, envPassword } from '../src/roku-config.js';
import { dropEmptyRokuVars } from '../src/env.js';

test('canonical names win over aliases', () => {
  assert.equal(envHost({ ROKU_IP: 'b', ROKU_DEVICE_HOST: 'a' }), 'a');
  assert.equal(envPassword({ ROKU_PASSWORD: 'c', ROKU_DEV_PASSWORD: 'b', ROKU_DEVICE_PASSWORD: 'a' }), 'a');
});

test('aliases resolve in order; empty values skipped', () => {
  assert.equal(envHost({ ROKU_DEV_TARGET: 'd', ROKU_HOST: 'c' }), 'c');
  assert.equal(envHost({ ROKU_DEVICE_HOST: '', ROKU_IP: '1.2.3.4' }), '1.2.3.4');
  assert.equal(envPassword({ ROKU_DEV_PASSWORD: 'pw' }), 'pw');
  assert.equal(envHost({}), undefined);
});

test('dropEmptyRokuVars deletes only empty ROKU_* vars', () => {
  const env: NodeJS.ProcessEnv = { ROKU_DEVICE_HOST: '', ROKU_IP: 'x', OTHER: '' };
  dropEmptyRokuVars(env);
  assert.deepEqual(env, { ROKU_IP: 'x', OTHER: '' });
});

test('dropEmptyRokuVars deletes unexpanded ${...} placeholders, so they cannot route LAN calls to RCE', () => {
  const env: NodeJS.ProcessEnv = { ROKU_RCE_DEVICE: '${user_config.ROKU_RCE_DEVICE}', ROKU_DEVICE_HOST: '10.0.0.2', OTHER: '${x}' };
  dropEmptyRokuVars(env);
  assert.deepEqual(env, { ROKU_DEVICE_HOST: '10.0.0.2', OTHER: '${x}' });
});
