import { createDataSource } from '../data-source.mjs';
import { createCoach } from '../coach.mjs';
import { createPreparedCoach } from '../prepared.mjs';
import fs from 'node:fs/promises';
import { SAVING_ACTIONS_VERSION } from '../saving-actions.mjs';
const dataSource = createDataSource();
try {
  const bundle = JSON.parse(await fs.readFile(new URL('../server-data/coach-answers.json', import.meta.url), 'utf8'));
  if (bundle.saving_version !== SAVING_ACTIONS_VERSION) {
    throw new Error('Savings summaries need regeneration with the current small-step and buffer guidance before deployment.');
  }
  await dataSource.warm();
  const prepared = createPreparedCoach({ dataSource, coach: createCoach({ dataSource }) });
  console.log(JSON.stringify({ message: 'Prepared customer answers match the database and prompt version', ...await prepared.ready() }));
} finally { dataSource.close(); }
