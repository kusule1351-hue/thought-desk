// The sample workspace the website's pictures and the marketing film are taken from: a student's semester, seeded
// into the browser preview's stand-in backend (src/dev-mock.ts).

import { randomUUID } from 'node:crypto';

// ------------------------------------------------------------- the workspace

/** Days from today to this week's weekday (1 is Monday). */
const weekday = (n, from = new Date()) => n - (((from.getDay() + 6) % 7) + 1);
/** The app's clock in the screenshots: this week's Wednesday, 8:40 in the
 * morning, a day with a lecture ahead and the week view at the start of it. */
export const NOW = new Date();
NOW.setDate(NOW.getDate() + weekday(3, NOW));
NOW.setHours(8, 40, 0, 0);

const iso = (offset) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const t = (text, ...marks) => (marks.length ? { type: 'text', text, marks: marks.map((type) => ({ type })) } : { type: 'text', text });
const p = (...content) => ({ type: 'paragraph', content });
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const tasks = (...items) => ({ type: 'taskList', content: items.map(([checked, ...content]) => ({ type: 'taskItem', attrs: { checked }, content: [p(...content)] })) });
const bullets = (...items) => ({ type: 'bulletList', content: items.map((text) => ({ type: 'listItem', content: [p(t(text))] })) });
const math = (latex) => ({ type: 'inlineMath', attrs: { latex } });
const mention = (id, kind = 'page') => ({ type: 'mention', attrs: { id, kind } });
const card = (id, front, back) => ({
  type: 'flashcard',
  attrs: { id },
  content: [
    { type: 'flashcardFront', content: [t(front)] },
    { type: 'flashcardBack', content: [t(back)] },
  ],
});
const doc = (...content) => JSON.stringify({ type: 'doc', content });

export function workspace() {
  const now = NOW.getTime();
  const page = (title, icon, parentId, position, content = '', extra = {}) => ({
    id: randomUUID(),
    parentId,
    title,
    icon,
    position,
    favorite: 0,
    fullWidth: false,
    createdAt: now,
    updatedAt: now - position * 60_000,
    deletedAt: null,
    tags: [],
    kind: '',
    sharedRoom: null,
    content,
    text: '',
    ...extra,
  });
  const course = (name, color, position, pageId, extra = {}) => ({
    id: randomUUID(),
    name,
    color,
    position,
    createdAt: now,
    teacher: '',
    email: '',
    officeHours: '',
    room: '',
    pageId,
    weights: {},
    ...extra,
  });
  const assignment = (title, courseId, dueDate, extra = {}) => ({
    id: randomUUID(),
    title,
    courseId,
    dueDate,
    dueTime: null,
    status: 'todo',
    priority: 0,
    notes: '',
    pageId: null,
    fileIds: [],
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    deletedAt: null,
    tags: [],
    sourceUid: null,
    score: null,
    maxScore: null,
    category: '',
    ...extra,
  });
  const event = (title, startDate, startTime, endTime, extra = {}) => ({
    id: randomUUID(),
    title,
    startDate,
    startTime,
    endDate: startDate,
    endTime,
    color: '',
    courseId: null,
    location: '',
    notes: '',
    repeat: 'none',
    repeatUntil: null,
    pageId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    tags: [],
    exdates: [],
    sourceUid: null,
    ...extra,
  });

  const biology = page('Biology', 'icon:dna:green', null, 0);
  const history = page('History', 'icon:landmark:orange', null, 1);
  const cs = page('Computer Science', 'icon:code:blue', null, 2);
  const bio = course('Biology', 'green', 0, biology.id, { teacher: 'Dr. Rivera', room: 'Science 204', officeHours: 'Tue 2–4 PM', weights: { Exams: 60, Labs: 40 } });
  const hist = course('History', 'orange', 1, history.id, { teacher: 'Prof. Okafor', room: 'Hall 3' });
  const comp = course('Computer Science', 'blue', 2, cs.id, { teacher: 'Dr. Lindqvist', room: 'Lab 2' });

  const lab = assignment('Lab report: osmosis', bio.id, iso(1), { dueTime: '23:59', priority: 3, status: 'doing', tags: ['lab'], category: 'Labs' });
  const deck = page(
    'Cell vocabulary',
    'icon:layers:green',
    biology.id,
    1,
    doc(
      p(t('Key terms for the midterm.')),
      card('k1', 'Mitochondria', 'Makes the cell’s energy (ATP)'),
      card('k2', 'Osmosis', 'Water moving across a membrane toward more solute'),
      card('k3', 'Ribosome', 'Builds proteins'),
      card('k4', 'Nucleus', 'Holds the cell’s DNA'),
      card('k5', 'Cell membrane', 'Controls what enters and leaves the cell'),
      card('k6', 'Chloroplast', 'Turns light into chemical energy'),
      card('k7', 'Vacuole', 'Stores water and keeps a plant cell firm'),
      card('k8', 'Diffusion', 'Particles spreading from high to low concentration'),
    ),
  );
  const lecture = page(
    'Osmosis and water potential',
    'icon:notebook-pen:green',
    biology.id,
    0,
    doc(
      { type: 'callout', attrs: { icon: 'icon:lightbulb:yellow' }, content: [p(t('On the midterm: '), t('osmosis, water potential and the microscope lab.', 'bold'))] },
      p(t('Osmosis', 'bold'), t(' is water moving across a membrane toward the side with more dissolved solute. A cell gains or loses water until the pull on both sides is equal.')),
      h(2, 'Water potential'),
      p(t('Water flows from higher to lower water potential, '), math('\\Psi'), t(', measured in megapascals:')),
      { type: 'mathBlock', attrs: { latex: '\\Psi = \\Psi_s + \\Psi_p' } },
      p(t('Here '), math('\\Psi_s'), t(' is the solute potential, zero or below, and '), math('\\Psi_p'), t(' is the pressure potential, the push of the cell wall.')),
      h(2, 'To do'),
      tasks([true, t('Read chapter 4, pages 88–104')], [false, t('Finish '), mention(lab.id, 'assignment')], [false, t('Review '), mention(deck.id)]),
    ),
    { favorite: now },
  );
  const pages = [
    biology,
    lecture,
    deck,
    page('Microscope lab', 'icon:microscope:green', biology.id, 2, doc(p(t('Onion skin at 400×: the cell walls are easy to see, the nuclei need the stain.')))),
    history,
    page(
      'Essay outline: the printing press',
      'icon:scroll-text:orange',
      history.id,
      0,
      doc(h(2, 'Thesis'), p(t('Cheap printing spread ideas faster than anyone could control them.')), h(2, 'Points'), bullets('Luther’s pamphlets', 'Scientific journals', 'Newspapers and rumour')),
    ),
    cs,
    page('Problem set 3 notes', 'icon:binary:blue', cs.id, 0, doc(p(t('Merge sort: split, sort each half, merge. '), math('O(n \\log n)'), t(' every time.')))),
    page(
      'Semester plan',
      'icon:target:purple',
      null,
      3,
      doc(p(t('Goals for this semester:')), tasks([false, t('Keep a B+ or better in Biology')], [false, t('Finish the History reading list')], [true, t('Start the CS project early')])),
      { favorite: now - 1 },
    ),
    page('Ideas', 'icon:lightbulb:yellow', null, 4, doc(bullets('A study timer that pauses with your calendar', 'Ask about the summer research program'))),
    page('Journal', 'icon:feather:pink', null, 5, doc(p(t('Long day, good lab. The osmosis results finally made sense.')))),
  ];

  // Weekly classes started a few weeks ago, so every week has them.
  const weekly = (title, day, start, end, courseId, location) =>
    event(title, iso(weekday(day, NOW) - 21), start, end, { courseId, location, repeat: 'weekly' });
  const planner = {
    courses: [bio, hist, comp],
    assignments: [
      lab,
      assignment('Read chapter 4', hist.id, iso(0), { priority: 1 }),
      assignment('Problem set 3', comp.id, iso(2), { dueTime: '17:00', priority: 2 }),
      assignment('Essay outline', hist.id, iso(5)),
      assignment('Group project proposal', comp.id, iso(9)),
      assignment('Quiz 1: cells', bio.id, iso(-10), { status: 'done', completedAt: now, score: 17, maxScore: 20, category: 'Exams' }),
      assignment('Lab: microscopes', bio.id, iso(-6), { status: 'done', completedAt: now, score: 46, maxScore: 50, category: 'Labs' }),
      assignment('Weekly reflection', null, iso(-3), { status: 'done', completedAt: now }),
    ],
    events: [
      weekly('Biology lecture', 1, '09:00', '10:30', bio.id, 'Hall B'),
      weekly('Biology lecture', 3, '09:00', '10:30', bio.id, 'Hall B'),
      weekly('History seminar', 2, '13:00', '14:00', hist.id, 'Hall 3'),
      weekly('History seminar', 4, '13:00', '14:00', hist.id, 'Hall 3'),
      weekly('CS lab', 5, '11:00', '13:00', comp.id, 'Lab 2'),
      event('Study group', iso(0), '16:00', '18:00', { color: 'purple', location: 'Library' }),
      event('Office hours', iso(weekday(2, NOW)), '14:00', '15:00', { courseId: bio.id, location: 'Science 204' }),
      event('Midterm exam', iso(weekday(3, NOW) + 7), '10:00', '12:00', { courseId: comp.id, tags: ['exam'] }),
      event('Fall break', iso(weekday(1, NOW) + 14), null, null, { endDate: iso(weekday(1, NOW) + 18), color: 'teal' }),
    ],
    files: [],
    tags: [
      { name: 'exam', color: 'red' },
      { name: 'lab', color: 'green' },
    ],
    sessions: [],
    reviews: [],
  };
  return { pages, planner, lecture };
}

/** More books for the stand-in's sample reading list. */
export const BOOKS = [
  ['Frankenstein', 'Mary Shelley', 'finished', ['fiction', 'course'], 280, 'r5'],
  ['The Gene', 'Siddhartha Mukherjee', 'reading', ['science'], 592],
  ['Brave New World', 'Aldous Huxley', 'finished', ['fiction', 'course'], 288, 'r4'],
  ['Guns, Germs, and Steel', 'Jared Diamond', 'want', ['history'], 480],
  ['A Short History of Nearly Everything', 'Bill Bryson', 'reading', ['science', 'history'], 544],
  ['The Structure of Scientific Revolutions', 'Thomas S. Kuhn', 'want', ['science', 'course'], 264],
];
