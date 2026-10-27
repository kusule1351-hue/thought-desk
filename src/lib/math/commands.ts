/**
 * LaTeX the math editor suggests as you type a backslash, and the symbol
 * palette. `insert` is what goes in: empty `{}` are slots Tab moves between,
 * and `|` (if any) is where the caret starts.
 *
 * Names, inserts and previews are LaTeX and never translated. The words
 * that also find a command are messages, searched in the interface's
 * language and in English; the words of the piecewise template (\text{if })
 * go into the formula in the language of the day.
 */

import { searchText, t, type MessageKey } from '../i18n';

export interface MathCommand {
  /** What's typed after the backslash to find it. */
  name: string;
  insert: string;
  /** Typeset as the button / suggestion face. */
  preview: string;
  /** Plain words that also find it. */
  words?: MessageKey;
}

const c = (name: string, insert = `\\${name}`, preview = insert.replace(/\{\}/g, '{\\square}').replace('|', ''), words?: MessageKey): MathCommand => ({
  name,
  insert,
  preview,
  words,
});
const sym = (names: string, words?: MessageKey) => names.split(' ').map((n) => c(n, `\\${n}`, `\\${n}`, words));

export const STRUCTURES: MathCommand[] = [
  c('frac', '\\frac{}{}', '\\frac{a}{b}', 'blocks.math.search.frac'),
  c('sqrt', '\\sqrt{}', '\\sqrt{x}', 'blocks.math.search.sqrt'),
  c('nroot', '\\sqrt[]{}', '\\sqrt[n]{x}', 'blocks.math.search.nroot'),
  c('sup', '^{}', 'x^{n}', 'blocks.math.search.sup'),
  c('sub', '_{}', 'x_{i}', 'blocks.math.search.sub'),
  c('sum', '\\sum_{}^{}', '\\sum_{i=1}^{n}', 'blocks.math.search.sum'),
  c('prod', '\\prod_{}^{}', '\\prod_{i=1}^{n}', 'blocks.math.search.prod'),
  c('int', '\\int_{}^{}', '\\int_{a}^{b}', 'blocks.math.search.int'),
  c('iint', '\\iint_{}', '\\iint_{D}', 'blocks.math.search.iint'),
  c('oint', '\\oint_{}', '\\oint_{C}', 'blocks.math.search.oint'),
  c('lim', '\\lim_{ \\to }', '\\lim_{x\\to 0}', 'blocks.math.search.lim'),
  c('dv', '\\frac{d}{d}', '\\frac{dy}{dx}', 'blocks.math.search.dv'),
  c('pdv', '\\frac{\\partial }{\\partial }', '\\frac{\\partial f}{\\partial x}', 'blocks.math.search.pdv'),
  c('vec', '\\vec{}', '\\vec{v}', 'blocks.math.search.vec'),
  c('hat', '\\hat{}', '\\hat{x}', 'blocks.math.search.hat'),
  c('bar', '\\bar{}', '\\bar{x}', 'blocks.math.search.bar'),
  c('dot', '\\dot{}', '\\dot{x}', 'blocks.math.search.dot'),
  c('ddot', '\\ddot{}', '\\ddot{x}', 'blocks.math.search.ddot'),
  c('overline', '\\overline{}', '\\overline{AB}', 'blocks.math.search.overline'),
  c('binom', '\\binom{}{}', '\\binom{n}{k}', 'blocks.math.search.binom'),
  c('abs', '\\left| | \\right|', '|x|', 'blocks.math.search.abs'),
  c('norm', '\\left\\| | \\right\\|', '\\|v\\|', 'blocks.math.search.norm'),
  c('paren', '\\left( | \\right)', '\\left(\\square\\right)', 'blocks.math.search.paren'),
  c('pmatrix', '\\begin{pmatrix} | &  \\\\  &  \\end{pmatrix}', '\\left(\\begin{smallmatrix} a & b \\\\ c & d \\end{smallmatrix}\\right)', 'blocks.math.search.pmatrix'),
  c('bmatrix', '\\begin{bmatrix} | &  \\\\  &  \\end{bmatrix}', '\\left[\\begin{smallmatrix} a & b \\\\ c & d \\end{smallmatrix}\\right]', 'blocks.math.search.bmatrix'),
  c('vmatrix', '\\begin{vmatrix} | &  \\\\  &  \\end{vmatrix}', '\\left|\\begin{smallmatrix} a & b \\\\ c & d \\end{smallmatrix}\\right|', 'blocks.math.search.vmatrix'),
  c(
    'cases',
    `\\begin{cases} | & \\text{${t('blocks.math.casesIf')} }  \\\\  & \\text{${t('blocks.math.casesOtherwise')}} \\end{cases}`,
    '\\left\\{\\begin{smallmatrix} a \\\\ b \\end{smallmatrix}\\right.',
    'blocks.math.search.cases',
  ),
  c('aligned', '\\begin{aligned} | &=  \\\\  &=  \\end{aligned}', '\\begin{smallmatrix} a=b \\\\ \\;\\;=c \\end{smallmatrix}', 'blocks.math.search.aligned'),
  c('text', '\\text{}', '\\text{abc}', 'blocks.math.search.text'),
  c('mathbb', '\\mathbb{}', '\\mathbb{R}', 'blocks.math.search.mathbb'),
  c('mathbf', '\\mathbf{}', '\\mathbf{v}', 'blocks.math.search.mathbf'),
  c('mathrm', '\\mathrm{}', '\\mathrm{d}x', 'blocks.math.search.mathrm'),
  c('ce', '\\ce{}', '\\ce{H2O}', 'blocks.math.search.ce'),
  c('pu', '\\pu{}', '\\pu{m/s^2}', 'blocks.math.search.pu'),
];

export const GREEK: MathCommand[] = sym(
  'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega',
  'blocks.math.search.greek',
);

export const OPERATORS: MathCommand[] = [
  ...sym('pm mp times div cdot ast circ bullet oplus otimes', 'blocks.math.search.operators'),
  ...sym('partial nabla infty hbar ell Re Im angle degree', 'blocks.math.search.symbols'),
  ...sym('cup cap setminus emptyset forall exists nexists neg land lor', 'blocks.math.search.logic'),
];

export const RELATIONS: MathCommand[] = [
  ...sym('neq leq geq ll gg approx equiv sim simeq cong propto', 'blocks.math.search.relations'),
  ...sym('in notin subset subseteq supset supseteq perp parallel mid', 'blocks.math.search.setRelations'),
];

export const ARROWS: MathCommand[] = sym(
  'to rightarrow leftarrow leftrightarrow Rightarrow Leftarrow Leftrightarrow implies iff mapsto uparrow downarrow rightleftharpoons longrightarrow',
  'blocks.math.search.arrows',
);

/** Functions written upright (\sin x). Suggested, not on the palette. */
const FUNCTIONS: MathCommand[] = sym('sin cos tan csc sec cot arcsin arccos arctan sinh cosh tanh log ln exp det dim ker max min sup inf arg deg gcd', 'blocks.math.search.functions');

/** A few more that only autocomplete knows. */
const EXTRA: MathCommand[] = [
  ...sym('cdots ldots vdots ddots quad qquad', 'blocks.math.search.dots'),
  c('langle', '\\langle | \\rangle', '\\langle \\psi \\rangle', 'blocks.math.search.langle'),
  c('left', '\\left( | \\right)', '\\left(\\square\\right)', 'blocks.math.search.brackets'),
  c('overrightarrow', '\\overrightarrow{}', '\\overrightarrow{AB}', 'blocks.math.search.overrightarrow'),
  c('underbrace', '\\underbrace{}_{}', '\\underbrace{a+b}_{n}', 'blocks.math.search.underbrace'),
  c('boxed', '\\boxed{}', '\\boxed{x=1}', 'blocks.math.search.boxed'),
  c('cancel', '\\cancel{}', '\\cancel{x}', 'blocks.math.search.cancel'),
  c('mathcal', '\\mathcal{}', '\\mathcal{L}', 'blocks.math.search.mathcal'),
  c('operatorname', '\\operatorname{}', '\\operatorname{rank}', 'blocks.math.search.operatorname'),
];

/** The symbol palette's tabs. */
export const PALETTE = [
  { label: 'blocks.math.palette.structures', items: STRUCTURES },
  { label: 'blocks.math.palette.greek', items: GREEK },
  { label: 'blocks.math.palette.operators', items: OPERATORS },
  { label: 'blocks.math.palette.relations', items: RELATIONS },
  { label: 'blocks.math.palette.arrows', items: ARROWS },
] satisfies { label: MessageKey; items: MathCommand[] }[];

const ALL: MathCommand[] = (() => {
  const seen = new Set<string>();
  return [...STRUCTURES, ...GREEK, ...OPERATORS, ...RELATIONS, ...ARROWS, ...FUNCTIONS, ...EXTRA].filter((m) => !seen.has(m.name) && seen.add(m.name));
})();

/** Each command's words, in the interface's language and in English, worked out once. */
const WORDS = new Map(ALL.map((m) => [m, m.words ? searchText(m.words).toLowerCase() : '']));

/** Suggestions for what follows a backslash: name prefix first, then contains, then words. */
export function suggest(query: string, limit = 8): MathCommand[] {
  const q = query.toLowerCase();
  if (!q) return STRUCTURES.slice(0, limit);
  const starts = ALL.filter((m) => m.name.toLowerCase().startsWith(q)).sort((a, b) => (a.name.startsWith(query) ? 0 : 1) - (b.name.startsWith(query) ? 0 : 1) || a.name.length - b.name.length);
  const contains = ALL.filter((m) => !starts.includes(m) && m.name.toLowerCase().includes(q));
  const words = q.length > 2 ? ALL.filter((m) => !starts.includes(m) && !contains.includes(m) && WORDS.get(m)!.includes(q)) : [];
  return [...starts, ...contains, ...words].slice(0, limit);
}
