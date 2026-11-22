/** Every tool the assistant has. Nothing here deletes for good, shares, syncs, or reads a secret: those stay with the person. */

import type { Tool } from '../types';
import { databaseTools } from './databases';
import { noteTools } from './notes';
import { plannerTools } from './planner';

export const tools: Tool[] = [...noteTools, ...plannerTools, ...databaseTools];

export const toolNamed = (name: string) => tools.find((t) => t.name === name);
