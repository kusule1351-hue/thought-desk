/**
 * Where an account's vault lives. What `npm run deploy` puts on the internet
 * sets VAULT_JURISDICTION to "eu" (wrangler.jsonc), which keeps every vault's
 * storage and code in the EU, like the R2 bucket beside it. A vault's id
 * comes from its jurisdiction, so this can't change once people have vaults.
 * Run on this computer (the tests, `npm run dev`) it is unset: the local
 * runtime has no jurisdictions.
 */

/** A Durable Object namespace, as far as this needs to know it. */
export interface Jurisdictional<N> {
  jurisdiction(name: 'eu'): N;
}

/** The namespace vaults are looked up in. A value other than "eu" is refused
 *  rather than quietly storing people's notes somewhere else. */
export function vaultsIn<N extends Jurisdictional<N>>(vaults: N, jurisdiction: string | undefined): N {
  if (!jurisdiction) return vaults;
  if (jurisdiction !== 'eu') throw new Error(`VAULT_JURISDICTION must be "eu" or unset, not "${jurisdiction}"`);
  return vaults.jurisdiction('eu');
}
