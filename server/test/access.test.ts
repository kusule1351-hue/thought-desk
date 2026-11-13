import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mayUseSync } from '../src/access.ts';

test('closed unless the setting says everyone: only listed accounts get in', () => {
  const testers = { SYNC_ACCESS: 'testers', SYNC_TESTERS: 'user_a, user_b ,,user_c' };
  for (const id of ['user_a', 'user_b', 'user_c']) assert.equal(mayUseSync(id, testers), true, id);
  for (const id of ['user_d', 'user_', 'USER_A', '', ' ', 'user_a,user_b']) assert.equal(mayUseSync(id, testers), false, JSON.stringify(id));
});

test('a missing or misspelt setting never opens it', () => {
  for (const env of [{}, { SYNC_ACCESS: '' }, { SYNC_ACCESS: 'Everyone' }, { SYNC_ACCESS: 'all' }, { SYNC_ACCESS: 'testers' }, { SYNC_TESTERS: '' }, { SYNC_ACCESS: 'testers', SYNC_TESTERS: ' , ' }])
    assert.equal(mayUseSync('user_a', env), false, JSON.stringify(env));
});

test('open to everyone once the setting says so', () => {
  assert.equal(mayUseSync('user_anyone', { SYNC_ACCESS: 'everyone' }), true);
  assert.equal(mayUseSync('user_anyone', { SYNC_ACCESS: 'everyone', SYNC_TESTERS: 'user_a' }), true);
});
