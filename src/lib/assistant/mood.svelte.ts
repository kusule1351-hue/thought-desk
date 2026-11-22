/**
 * The face the assistant makes (ui/Face.svelte): it shows what it is
 * doing, so a glance at it says whether it is reading, waiting on you, pleased
 * with itself or stuck.
 */

import { assistant } from './assistant.svelte';

export type Mood =
  /** Not turned on yet. */
  | 'asleep'
  /** Needs an account before it can do anything. */
  | 'curious'
  | 'idle'
  /** Nothing has been asked of it for a while. */
  | 'bored'
  /** The person is typing to it. */
  | 'listening'
  | 'thinking'
  /** Deep in a task: it has looked several things up and isn't done. */
  | 'scheming'
  | 'reading'
  | 'writing'
  /** A change is waiting for a yes. */
  | 'asking'
  /** It just did something. */
  | 'proud'
  /** It was thanked. */
  | 'flattered'
  /** It was told no. */
  | 'sad'
  /** Its change was taken back. */
  | 'oops'
  /** Something went wrong. */
  | 'dizzy'
  /** The month's allowance is used up. */
  | 'broke'
  /** It wouldn't answer. */
  | 'nope';

/** Thanks, in a few of the languages it may be thanked in. */
const THANKS = /(^|[^\p{L}])(thanks|thank you|thx|gracias|merci|danke|obrigad[oa]|баярлалаа|спасибо)(?![\p{L}])|ありがとう|谢谢|감사/iu;

/** The mood for this moment. Reads the assistant's state, so it follows it wherever it is used. */
export function currentMood(typing = false): Mood {
  if (assistant.gate === 'off') return 'asleep';
  if (assistant.gate === 'signed-out') return 'curious';
  if (assistant.status === 'asking') return 'asking';
  const last = assistant.items[assistant.items.length - 1];
  if (assistant.status === 'working') {
    if (last?.type === 'read' && last.state === 'running') return 'reading';
    if (last?.type === 'answer' && last.writing && last.text) return 'writing';
    if (last?.type === 'change' && last.state === 'working') return 'writing';
    // Three things looked up since the question, and still going: it is up to something.
    let reads = 0;
    for (let i = assistant.items.length - 1; i >= 0 && assistant.items[i].type !== 'ask'; i--) if (assistant.items[i].type === 'read') reads++;
    return reads >= 3 ? 'scheming' : 'thinking';
  }
  if (typing) return 'listening';
  if (last?.type === 'notice') {
    if (last.reason === 'spent') return 'broke';
    if (last.reason === 'refused') return 'nope';
    if (last.reason === 'signed-out' || last.reason === 'closed') return 'curious';
    return 'dizzy';
  }
  // What the last answer came after: the change just before it sets the face.
  for (let i = assistant.items.length - 1; i >= 0; i--) {
    const item = assistant.items[i];
    if (item.type === 'ask') {
      if (THANKS.test(item.text) && last?.type === 'answer') return 'flattered';
      break;
    }
    if (item.type !== 'change') continue;
    if (item.state === 'done') return 'proud';
    if (item.state === 'declined') return 'sad';
    if (item.state === 'undone') return 'oops';
    if (item.state === 'failed') return 'dizzy';
  }
  return 'idle';
}
