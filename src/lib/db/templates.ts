/**
 * Ready-made databases: properties and views to start from.
 *
 * Their names (the database's title, its properties, options and views) are
 * written into the database made from one, in the interface's language at
 * the time. Code that finds them again goes by their ids ('status', 'due'…),
 * never by name. A template's formula names its properties, so it's built
 * from the same translated names.
 */

import { keysBetween } from './order';
import { STATUS_OPTIONS } from './schema';
import { t } from '../i18n';
import type { DbView, Property, PropertyConfig, PropertyType, SelectOption, ViewConfig, ViewType } from '../types';
import { lineIcon } from '../page-icon';

export interface Template {
  key: string;
  name: string;
  icon: string;
  description: string;
  properties: Property[];
  views: DbView[];
}

type P = [id: string, name: string, type: PropertyType, config?: PropertyConfig];
type V = [id: string, name: string, type: ViewType, config?: ViewConfig];

const opts = (...list: [string, string, string?][]): SelectOption[] =>
  list.map(([id, name, color]) => ({ id, name, color: color ?? 'gray' }));

function make(key: string, name: string, icon: string, description: string, title: string, props: P[], views: V[]): Template {
  const pk = keysBetween(null, null, props.length + 1);
  const vk = keysBetween(null, null, views.length);
  return {
    key,
    name,
    icon,
    description,
    properties: [
      { id: 'title', name: title, type: 'title', config: {}, sortKey: pk[0] },
      ...props.map(([id, n, type, config], i) => ({ id, name: n, type, config: config ?? {}, sortKey: pk[i + 1] })),
    ],
    views: views.map(([id, n, type, config], i) => ({ id, name: n, type, config: config ?? {}, sortKey: vk[i] })),
  };
}

const priority = opts(
  ['low', t('database.templates.priority.low'), 'gray'],
  ['medium', t('database.templates.priority.medium'), 'yellow'],
  ['high', t('database.templates.priority.high'), 'red'],
);

/** The habit tracker's checkboxes, named once: its Score formula adds them up by name. */
const habit = {
  exercise: t('database.templates.habits.props.exercise'),
  read: t('database.templates.habits.props.read'),
  sleep: t('database.templates.habits.props.sleep'),
  water: t('database.templates.habits.props.water'),
};

export const TEMPLATES: Template[] = [
  make(
    'blank',
    t('database.templates.blank.name'),
    lineIcon('database'),
    t('database.templates.blank.description'),
    t('common.name'),
    [['notes', t('common.notes'), 'text']],
    [['table', t('database.viewNames.table'), 'table']],
  ),
  make(
    'tasks',
    t('database.templates.tasks.name'),
    lineIcon('list-checks', 'blue'),
    t('database.templates.tasks.description'),
    t('database.templates.tasks.props.title'),
    [
      ['status', t('database.templates.tasks.props.status'), 'status', { options: STATUS_OPTIONS.map((o) => ({ ...o })) }],
      ['due', t('database.templates.tasks.props.due'), 'date', { onCalendar: true }],
      ['priority', t('database.templates.tasks.props.priority'), 'select', { options: priority }],
      ['course', t('common.course'), 'course'],
    ],
    [
      ['board', t('database.viewNames.board'), 'board', { group: 'status' }],
      ['table', t('database.templates.tasks.views.allTasks'), 'table', { sorts: [{ prop: 'due', dir: 'asc' }] }],
      ['calendar', t('database.viewNames.calendar'), 'calendar', { dateProp: 'due' }],
    ],
  ),
  make(
    'projects',
    t('database.templates.projects.name'),
    lineIcon('rocket', 'purple'),
    t('database.templates.projects.description'),
    t('database.templates.projects.props.title'),
    [
      ['status', t('database.templates.projects.props.status'), 'status', { options: STATUS_OPTIONS.map((o) => ({ ...o })) }],
      ['dates', t('database.templates.projects.props.dates'), 'date', { onCalendar: true }],
      ['progress', t('database.templates.projects.props.progress'), 'number', { format: 'percent', display: 'bar', max: 100 }],
      ['priority', t('database.templates.projects.props.priority'), 'select', { options: priority }],
      ['tags', t('common.tags'), 'tags'],
    ],
    [
      ['table', t('database.templates.projects.views.allProjects'), 'table'],
      ['board', t('database.templates.projects.views.byStatus'), 'board', { group: 'status' }],
      ['calendar', t('database.viewNames.timeline'), 'calendar', { dateProp: 'dates' }],
    ],
  ),
  make(
    'reading',
    t('database.templates.reading.name'),
    lineIcon('book-open', 'orange'),
    t('database.templates.reading.description'),
    t('database.templates.reading.props.title'),
    [
      ['author', t('database.templates.reading.props.author'), 'text'],
      [
        'status',
        t('database.templates.reading.props.status'),
        'select',
        {
          options: opts(
            ['want', t('database.templates.reading.options.want'), 'gray'],
            ['reading', t('database.templates.reading.options.reading'), 'blue'],
            ['finished', t('database.templates.reading.options.finished'), 'green'],
          ),
        },
      ],
      ['rating', t('database.templates.reading.props.rating'), 'select', { options: opts(['r1', '★', 'yellow'], ['r2', '★★', 'yellow'], ['r3', '★★★', 'yellow'], ['r4', '★★★★', 'yellow'], ['r5', '★★★★★', 'yellow']) }],
      [
        'genre',
        t('database.templates.reading.props.genre'),
        'multiSelect',
        {
          options: opts(
            ['fiction', t('database.templates.reading.options.fiction'), 'purple'],
            ['science', t('database.templates.reading.options.science'), 'teal'],
            ['history', t('database.templates.reading.options.history'), 'orange'],
            ['course', t('database.templates.reading.options.forClass'), 'blue'],
          ),
        },
      ],
      ['pages', t('database.templates.reading.props.pages'), 'number'],
      ['finished', t('database.templates.reading.props.finished'), 'date'],
    ],
    [
      ['gallery', t('database.templates.reading.views.shelf'), 'gallery', { cover: 'page', shown: ['author', 'rating'] }],
      ['board', t('database.templates.reading.views.byStatus'), 'board', { group: 'status', shown: ['author', 'rating'] }],
      ['table', t('database.viewNames.table'), 'table'],
    ],
  ),
  make(
    'habits',
    t('database.templates.habits.name'),
    lineIcon('sprout', 'green'),
    t('database.templates.habits.description'),
    t('database.templates.habits.props.title'),
    [
      ['date', t('database.templates.habits.props.date'), 'date'],
      ['exercise', habit.exercise, 'checkbox'],
      ['read', habit.read, 'checkbox'],
      ['sleep', habit.sleep, 'checkbox'],
      ['water', habit.water, 'checkbox'],
      [
        'score',
        t('database.templates.habits.props.score'),
        'formula',
        { expression: `round(({${habit.exercise}} + {${habit.read}} + {${habit.sleep}} + {${habit.water}}) / 4 * 100)`, format: 'percent', display: 'bar', max: 100 },
      ],
    ],
    [
      [
        'table',
        t('database.templates.habits.views.thisMonth'),
        'table',
        {
          sorts: [{ prop: 'date', dir: 'desc' }],
          filters: [{ id: 'f1', prop: 'date', op: 'thisMonth' }],
          calc: { exercise: 'percentChecked', read: 'percentChecked', sleep: 'percentChecked', water: 'percentChecked', score: 'average' },
        },
      ],
      ['calendar', t('database.viewNames.calendar'), 'calendar', { dateProp: 'date' }],
      ['all', t('database.templates.habits.views.allDays'), 'table', { sorts: [{ prop: 'date', dir: 'desc' }] }],
    ],
  ),
  make(
    'study',
    t('database.templates.study.name'),
    lineIcon('clock', 'yellow'),
    t('database.templates.study.description'),
    t('database.templates.study.props.title'),
    [
      ['course', t('common.course'), 'course'],
      ['date', t('database.templates.study.props.date'), 'date'],
      ['minutes', t('database.templates.study.props.minutes'), 'number'],
      [
        'focus',
        t('database.templates.study.props.focus'),
        'select',
        {
          options: opts(
            ['low', t('database.templates.study.options.low'), 'gray'],
            ['ok', t('database.templates.study.options.ok'), 'yellow'],
            ['deep', t('database.templates.study.options.deep'), 'green'],
          ),
        },
      ],
    ],
    [
      ['table', t('database.templates.study.views.log'), 'table', { sorts: [{ prop: 'date', dir: 'desc' }], calc: { minutes: 'sum' } }],
      ['chart', t('database.templates.study.views.minutesPerCourse'), 'chart', { chart: { kind: 'bar', x: 'course', agg: 'sum', y: 'minutes' } }],
      ['calendar', t('database.viewNames.calendar'), 'calendar', { dateProp: 'date' }],
    ],
  ),
  make(
    'expenses',
    t('database.templates.expenses.name'),
    lineIcon('wallet', 'teal'),
    t('database.templates.expenses.description'),
    t('database.templates.expenses.props.title'),
    [
      ['amount', t('database.templates.expenses.props.amount'), 'number', { format: 'dollar' }],
      [
        'category',
        t('database.templates.expenses.props.category'),
        'select',
        {
          options: opts(
            ['food', t('database.templates.expenses.options.food'), 'orange'],
            ['rent', t('database.templates.expenses.options.rent'), 'blue'],
            ['transport', t('database.templates.expenses.options.transport'), 'teal'],
            ['books', t('database.templates.expenses.options.books'), 'purple'],
            ['fun', t('database.templates.expenses.options.fun'), 'pink'],
            ['other', t('database.templates.expenses.options.otherCategory'), 'gray'],
          ),
        },
      ],
      ['date', t('database.templates.expenses.props.date'), 'date'],
      ['paid', t('database.templates.expenses.props.paid'), 'checkbox'],
    ],
    [
      ['table', t('database.templates.expenses.views.allSpending'), 'table', { sorts: [{ prop: 'date', dir: 'desc' }], calc: { amount: 'sum', paid: 'percentChecked' } }],
      ['chart', t('database.templates.expenses.views.byCategory'), 'chart', { chart: { kind: 'donut', x: 'category', agg: 'sum', y: 'amount' } }],
      ['month', t('database.templates.expenses.views.thisMonth'), 'table', { filters: [{ id: 'f1', prop: 'date', op: 'thisMonth' }], calc: { amount: 'sum' } }],
    ],
  ),
  make(
    'applications',
    t('database.templates.applications.name'),
    lineIcon('briefcase', 'indigo'),
    t('database.templates.applications.description'),
    t('database.templates.applications.props.title'),
    [
      ['company', t('database.templates.applications.props.company'), 'text'],
      [
        'stage',
        t('database.templates.applications.props.stage'),
        'select',
        {
          options: opts(
            ['wish', t('database.templates.applications.options.wish'), 'gray'],
            ['applied', t('database.templates.applications.options.applied'), 'blue'],
            ['interview', t('database.templates.applications.options.interview'), 'purple'],
            ['offer', t('database.templates.applications.options.offer'), 'green'],
            ['no', t('database.templates.applications.options.no'), 'red'],
          ),
        },
      ],
      ['applied', t('database.templates.applications.props.appliedOn'), 'date'],
      ['deadline', t('database.templates.applications.props.deadline'), 'date', { onCalendar: true }],
      ['link', t('database.templates.applications.props.link'), 'url'],
      ['contact', t('database.templates.applications.props.contact'), 'email'],
    ],
    [
      ['board', t('database.templates.applications.views.pipeline'), 'board', { group: 'stage', shown: ['company', 'deadline'] }],
      ['table', t('database.viewNames.table'), 'table', { sorts: [{ prop: 'deadline', dir: 'asc' }] }],
    ],
  ),
  make(
    'contacts',
    t('database.templates.contacts.name'),
    lineIcon('users', 'pink'),
    t('database.templates.contacts.description'),
    t('common.name'),
    [
      ['email', t('database.templates.contacts.props.email'), 'email'],
      ['phone', t('database.templates.contacts.props.phone'), 'phone'],
      ['course', t('common.course'), 'course'],
      ['birthday', t('database.templates.contacts.props.birthday'), 'date'],
      ['tags', t('common.tags'), 'tags'],
    ],
    [
      ['table', t('database.templates.contacts.views.everyone'), 'table'],
      ['gallery', t('database.templates.contacts.views.cards'), 'gallery', { shown: ['email', 'course'] }],
    ],
  ),
  make(
    'recipes',
    t('database.templates.recipes.name'),
    lineIcon('utensils', 'red'),
    t('database.templates.recipes.description'),
    t('database.templates.recipes.props.title'),
    [
      [
        'meal',
        t('database.templates.recipes.props.meal'),
        'multiSelect',
        {
          options: opts(
            ['breakfast', t('database.templates.recipes.options.breakfast'), 'yellow'],
            ['lunch', t('database.templates.recipes.options.lunch'), 'green'],
            ['dinner', t('database.templates.recipes.options.dinner'), 'orange'],
            ['snack', t('database.templates.recipes.options.snack'), 'pink'],
          ),
        },
      ],
      ['minutes', t('database.templates.recipes.props.minutes'), 'number'],
      ['tried', t('database.templates.recipes.props.tried'), 'checkbox'],
      ['source', t('database.templates.recipes.props.source'), 'url'],
    ],
    [
      ['gallery', t('database.viewNames.gallery'), 'gallery', { cover: 'page', cardSize: 'medium', shown: ['meal', 'minutes'] }],
      ['table', t('database.viewNames.table'), 'table'],
    ],
  ),
];
