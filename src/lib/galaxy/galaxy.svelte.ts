/** What the Galaxy view centres on, shared with the menus that open it. */

import { store } from '../store.svelte';

class GalaxyFocus {
  /** Which page the Galaxy view should centre on, set by "Show in Galaxy". */
  page = $state<string | null>(null);

  /** Opens the Galaxy on page `id`. */
  show(id: string) {
    this.page = id;
    store.go('galaxy');
  }

  /** Forgets which page to centre on. */
  clear() {
    this.page = null;
  }
}

export const galaxy = new GalaxyFocus();
