/** The editor's real schema, built once (the same blocks every copy of the app has). */

import { getSchema } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { buildExtensions } from '../editor/extensions';

let schema: Schema | null = null;

export function syncSchema(): Schema {
  return (schema ??= getSchema(buildExtensions({ onMenu: () => {} })));
}
