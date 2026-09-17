import { writeFile } from 'node:fs/promises';

import { buildApp } from '../src/api/app.js';
import { db } from '../src/db.js';

// The committed openapi.json is generated from the routes, never edited.
// Nothing here enqueues, so the queue is never created and Redis is never
// touched (see the lazy construction in src/queue.ts).
const app = await buildApp();
await app.ready();
await writeFile('openapi.json', `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
await db.$disconnect();
process.stdout.write('wrote openapi.json\n');
