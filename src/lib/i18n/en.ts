/**
 * The English messages, one file per area of the app (src/locales/en). They
 * are complete, they're what every other language falls back to, and their
 * shape is where the message keys' type comes from (index.ts: MessageKey).
 * A new area needs its file here and in every other language's folder.
 */
import common from '../../locales/en/common.json';
import app from '../../locales/en/app.json';
import shell from '../../locales/en/shell.json';
import settings from '../../locales/en/settings.json';
import onboarding from '../../locales/en/onboarding.json';
import pages from '../../locales/en/pages.json';
import editor from '../../locales/en/editor.json';
import blocks from '../../locales/en/blocks.json';
import planner from '../../locales/en/planner.json';
import sheets from '../../locales/en/sheets.json';
import library from '../../locales/en/library.json';
import social from '../../locales/en/social.json';
import database from '../../locales/en/database.json';
import dbTable from '../../locales/en/dbTable.json';
import dbViews from '../../locales/en/dbViews.json';
import dbEdit from '../../locales/en/dbEdit.json';
import dbAuto from '../../locales/en/dbAuto.json';

export const en = { common, app, shell, settings, onboarding, pages, editor, blocks, planner, sheets, library, social, database, dbTable, dbViews, dbEdit, dbAuto };
export type Messages = typeof en;
