import { createDataSource } from '../data-source.mjs';
import { createCoach } from '../coach.mjs';
import { createPreparedCoach } from '../prepared.mjs';
const dataSource = createDataSource();
try {
  await dataSource.warm();
  const prepared = createPreparedCoach({ dataSource, coach: createCoach({ dataSource }) });
  console.log(JSON.stringify({ message: 'Prepared customer answers match the database and prompt version', ...await prepared.ready() }));
} finally { dataSource.close(); }
