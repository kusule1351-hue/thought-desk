/**
 * What a tool is, to the assistant's loop (assistant.svelte.ts) and to the
 * panel that shows what it does.
 *
 * `read` tools run as soon as the model asks. `create` and `edit` tools change
 * something, so the person is shown a preview and decides first; what they did
 * can be taken back afterwards.
 */

export type ToolKind = 'read' | 'create' | 'edit';

/** The model's input can't work (a page that isn't there, a date that isn't one). The message goes back to the model as the tool's error. */
export class ToolError extends Error {}

/** What a change would do, shown before it is allowed. */
export interface Preview {
  /** One line: "Create the note “Cell biology”". */
  title: string;
  /** Details, as label and value ("Due", "Friday 28 November"). */
  lines?: { label: string; value: string }[];
  /** New text, as Markdown (a new note's body, text being added). */
  body?: string;
  /** An edit: the text as it is and as it would be, both Markdown. */
  before?: string;
  after?: string;
}

/** Where a change is, so the panel can link to it. */
export interface Place {
  kind: 'page' | 'assignment' | 'event';
  id: string;
}

/** A change that was made. */
export interface Done {
  /** One line for the person: "Created the note “Cell biology”". */
  summary: string;
  /** What the model is told (the ids it may need next). */
  result: string;
  place?: Place;
  /** Takes the change back. Left out when it can't be. */
  undo?: () => Promise<void>;
  /** Whether taking it back now would also lose something done since (the panel asks first). */
  undoLoses?: () => Promise<boolean>;
}

export interface ToolContext {
  signal: AbortSignal;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Tool<I = any> {
  /** `snake_case`; what the model calls. */
  name: string;
  kind: ToolKind;
  /** For the model: what it does, when to use it, what it returns. */
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  /** For the person, while a read runs: "Searching notes for “mitosis”". */
  label(input: I): string;
  /**
   * `create` and `edit` only: checks the input and says what would happen,
   * changing nothing. Throws ToolError when the input can't work.
   */
  preview?(input: I): Promise<Preview> | Preview;
  /** A read returns text for the model. A change is made here, after the person allowed it. */
  run(input: I, cx: ToolContext): Promise<string | Done>;
}
