import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vaultsIn } from '../src/region.ts';

/** A stand-in namespace that remembers which jurisdiction it was asked for. */
class Namespace {
  where = 'none';
  jurisdiction(name: 'eu') {
    const inside = new Namespace();
    inside.where = name;
    return inside;
  }
}

test('vaults are in the EU where the setting says so, and plain where it is unset', () => {
  assert.equal(vaultsIn(new Namespace(), 'eu').where, 'eu');
  assert.equal(vaultsIn(new Namespace(), undefined).where, 'none');
  assert.equal(vaultsIn(new Namespace(), '').where, 'none');
});

test('any other jurisdiction is refused, not stored somewhere else', () => {
  for (const other of ['us', 'EU', 'fedramp', ' eu']) assert.throws(() => vaultsIn(new Namespace(), other), /VAULT_JURISDICTION/, other);
});
