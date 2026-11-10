// Who gets into a room. Run with `npm test` (Node's own test runner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, UnsecuredJWT, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { authorize, isLocal, personOf, tokenFrom, type AuthDeps, type AuthEnv } from '../src/auth.ts';

const DEV = 'https://example-dev.clerk.accounts.dev';
const PROD = 'https://clerk.thoughtdesk.org';
const env: AuthEnv = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_KEY: 'sb_publishable_test',
  CLERK_ISSUERS: `${DEV}, ${PROD}`,
  APP_ORIGINS: 'http://tauri.localhost,http://localhost:1420',
};
const ROOM = '0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const ANA = 'user_2ana0000000000000000000000';

// Clerk signs session tokens with RS256; each instance has its own keys.
const clerk = await generateKeyPair('RS256');
const stranger = await generateKeyPair('RS256');
const keysOf = new Map<string, CryptoKey>([
  [DEV, clerk.publicKey],
  [PROD, clerk.publicKey],
]);
const keys = (issuer: string): JWTVerifyGetKey => async () => {
  const key = keysOf.get(issuer);
  if (!key) throw new Error(`asked for the keys of ${issuer}`);
  return key;
};

/** A Clerk session token, with what Clerk puts in one. `issued` is seconds before now; `expires` null leaves `exp` out. */
function token({
  sub = ANA as string | null,
  iss = DEV,
  azp = 'http://tauri.localhost' as string | undefined,
  sts = 'active',
  expires = '1m' as string | null,
  issued = 0 as number | null,
  act = undefined as unknown,
  key = clerk.privateKey,
} = {}) {
  const claims: Record<string, unknown> = { sid: 'sess_1', sts, v: 2, role: 'authenticated' };
  if (azp !== undefined) claims.azp = azp;
  if (act !== undefined) claims.act = act;
  const jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'ins_1' }).setIssuer(iss);
  if (sub !== null) jwt.setSubject(sub);
  if (issued !== null) jwt.setIssuedAt(Math.floor(Date.now() / 1000) - issued);
  if (expires !== null) jwt.setExpirationTime(expires);
  return jwt.sign(key);
}

/** Supabase's answer to "is this session active and mine?", and what it was asked. */
function supabase(rows: unknown[]) {
  const asked: { url: string; auth: string | null }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    asked.push({ url, auth: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof globalThis.fetch;
  return { deps: { keys, fetch } satisfies AuthDeps, asked };
}


test('someone in the active session gets in, checked with their own token', async () => {
  const t = await token();
  const { deps, asked } = supabase([{ id: ROOM }]);
  assert.deepEqual(await authorize(t, ROOM, false, env, deps), { ok: true, userId: ANA });
  assert.equal(asked.length, 1);
  assert.match(asked[0].url, new RegExp(`cowork_sessions\\?id=eq\\.${ROOM}&status=eq\\.active`));
  assert.equal(asked[0].auth, `Bearer ${t}`);
});

test('either Clerk instance will do, and a token made without a page (no azp) too', async () => {
  for (const t of [await token({ iss: PROD }), await token({ azp: 'http://localhost:1420' }), await token({ azp: undefined })])
    assert.equal(await personOf(t, env, keys), ANA);
});

test('someone not in it (or after it ended) is turned away', async () => {
  const { deps } = supabase([]);
  const verdict = await authorize(await token(), ROOM, false, env, deps);
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.status, 403);
});

test('no token, an expired one, or one not from our Clerk for the app is refused', async () => {
  const { deps, asked } = supabase([{ id: ROOM }]);
  const refused = {
    'no token': '',
    'not a token': 'not-a-token',
    expired: await token({ expires: '-1m' }),
    'another Clerk instance': await token({ iss: 'https://someone-else.clerk.accounts.dev' }),
    'Supabase Auth': await token({ iss: 'https://project.supabase.co/auth/v1' }),
    'signed with other keys': await token({ key: stranger.privateKey }),
    'made on another page': await token({ azp: 'https://evil.example' }),
    'a session waiting on a step': await token({ sts: 'pending' }),
    'no user': await token({ sub: '' }),
    'no subject at all': await token({ sub: null }),
    'no expiry': await token({ expires: null }),
    'no issue time': await token({ issued: null }),
    'issued 11 minutes ago, though still valid': await token({ issued: 11 * 60, expires: '5m' }),
    'unsigned (alg none)': new UnsecuredJWT({ sid: 'sess_1', sts: 'active' }).setIssuer(DEV).setSubject(ANA).setIssuedAt().setExpirationTime('1m').encode(),
  };
  for (const [what, t] of Object.entries(refused)) {
    const verdict = await authorize(t, ROOM, false, env, deps);
    assert.equal(verdict.ok, false, what);
    assert.equal(!verdict.ok && verdict.status, 401, what);
  }
  assert.equal(asked.length, 0, 'never asks Supabase about a bad token');
});

test('a token a few minutes old is still fine; impersonation depends on the caller', async () => {
  assert.equal(await personOf(await token({ issued: 9 * 60, expires: '5m' }), env, keys), ANA);
  const acting = await token({ act: { sub: 'user_support' } });
  assert.equal(await personOf(acting, env, keys), ANA, 'rooms accept it as before');
  assert.equal(await personOf(acting, env, keys, { impersonation: false }), null, 'the mailbox does not');
  assert.equal(await personOf(await token(), env, keys, { impersonation: false }), ANA);
});

test('production config trusts only the production instance', async () => {
  const production = { ...env, CLERK_ISSUERS: PROD, APP_ORIGINS: 'http://tauri.localhost,tauri://localhost' };
  assert.equal(await personOf(await token({ iss: PROD }), production, keys), ANA);
  assert.equal(await personOf(await token({ iss: DEV }), production, keys), null, 'the development instance');
  assert.equal(await personOf(await token({ azp: 'http://localhost:1420', iss: PROD }), production, keys), null, 'the browser preview');
});

test('test sign-ins work only in test mode, and only from this computer', async () => {
  const { deps } = supabase([]);
  const fake = 'test.11111111-1111-4111-8111-111111111111';
  assert.equal((await authorize(fake, ROOM, true, env, deps)).ok, false, 'not without test mode');
  const testing = { ...env, AUTH_MODE: 'test' };
  assert.deepEqual(await authorize(fake, ROOM, true, testing, deps), { ok: true, userId: '11111111-1111-4111-8111-111111111111' });
  assert.equal((await authorize(fake, ROOM, false, testing, deps)).ok, false, 'never from outside');
  assert.equal((await authorize('test.nope', ROOM, true, testing, deps)).ok, false);
});

test('only a request from this computer counts as local', () => {
  const from = (ip?: string) => new Request('https://relay.thoughtdesk.org/', { headers: ip ? { 'CF-Connecting-IP': ip } : {} });
  assert.equal(isLocal(from('127.0.0.1')), true);
  assert.equal(isLocal(from('::1')), true);
  assert.equal(isLocal(from('203.0.113.7')), false);
  assert.equal(isLocal(from()), false);
});

test('the token comes from the subprotocols, only after "thoughtdesk"', () => {
  assert.equal(tokenFrom('thoughtdesk, eyJ.a.b'), 'eyJ.a.b');
  assert.equal(tokenFrom('thoughtdesk,eyJ.a.b'), 'eyJ.a.b');
  assert.equal(tokenFrom('thoughtdesk'), '');
  assert.equal(tokenFrom('other, eyJ.a.b'), '');
  assert.equal(tokenFrom(null), '');
});
