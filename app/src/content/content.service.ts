import { Injectable, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { isEnoent } from '../common/errors';
import { contentDir, themesDir } from '../config/paths';

/** Theme ids are plain file basenames; anything else is treated as unknown (also blocks path traversal). */
const THEME_ID = /^[a-z0-9][a-z0-9_-]*$/i;

@Injectable()
export class ContentService {
  async getContent(): Promise<unknown> {
    const file = path.join(contentDir(), 'content.json');
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    } catch (err) {
      if (isEnoent(err)) {
        throw new NotFoundException({ error: 'content.json not found' });
      }
      throw err;
    }
  }

  async listThemes(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(themesDir());
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.basename(name, '.json'))
      .sort();
  }

  async getTheme(id: string): Promise<unknown> {
    if (!THEME_ID.test(id)) {
      throw new NotFoundException({ error: `unknown theme: ${id}` });
    }
    const file = path.join(themesDir(), `${id}.json`);
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    } catch (err) {
      if (isEnoent(err)) {
        throw new NotFoundException({ error: `unknown theme: ${id}` });
      }
      throw err;
    }
  }
}
