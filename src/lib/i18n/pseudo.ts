/**
 * The pseudo-language (development only): every English message with its
 * letters accented, wrapped in ⟦ ⟧ and made about a third longer. Anything
 * still in plain English on screen was missed; anything cut off won't fit
 * longer languages either. {placeholders} and <tags> are left as they are.
 */
import type { Plural } from './index';

const ACCENTS: Record<string, string> = {
  a: 'ȧ', b: 'ƀ', c: 'ƈ', d: 'ḓ', e: 'ḗ', f: 'ƒ', g: 'ɠ', h: 'ħ', i: 'ī', j: 'ĵ', k: 'ķ', l: 'ŀ', m: 'ḿ',
  n: 'ƞ', o: 'ǿ', p: 'ƥ', q: 'ɋ', r: 'ř', s: 'ş', t: 'ŧ', u: 'ŭ', v: 'ṽ', w: 'ẇ', x: 'ẋ', y: 'ẏ', z: 'ẑ',
  A: 'Ȧ', B: 'Ɓ', C: 'Ƈ', D: 'Ḓ', E: 'Ḗ', F: 'Ƒ', G: 'Ɠ', H: 'Ħ', I: 'Ī', J: 'Ĵ', K: 'Ķ', L: 'Ŀ', M: 'Ḿ',
  N: 'Ƞ', O: 'Ǿ', P: 'Ƥ', Q: 'Ɋ', R: 'Ř', S: 'Ş', T: 'Ŧ', U: 'Ŭ', V: 'Ṽ', W: 'Ẇ', X: 'Ẋ', Y: 'Ẏ', Z: 'Ẑ',
};

function stretch(text: string): string {
  if (!text.trim()) return text;
  // Accent letters outside {placeholders} and <tags>.
  const accented = text.replace(/(\{\w+\}|<\/?\w+\s*\/?>)|([A-Za-z])/g, (_, keep: string, ch: string) => keep ?? ACCENTS[ch] ?? ch);
  const letters = text.replace(/\{\w+\}|<\/?\w+\s*\/?>/g, '').length;
  return `⟦${accented}${'·'.repeat(Math.ceil(letters / 3))}⟧`;
}

export function pseudo(english: Map<string, string | Plural>): Map<string, string | Plural> {
  const out = new Map<string, string | Plural>();
  for (const [key, msg] of english) {
    out.set(key, typeof msg === 'string' ? stretch(msg) : (Object.fromEntries(Object.entries(msg).map(([form, text]) => [form, stretch(text)])) as Plural));
  }
  return out;
}
