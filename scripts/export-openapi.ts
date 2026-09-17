import { writeFile } from 'node:fs/promises';

import { buildApp } from '../src/api/app.js';
import { db } from '../src/db.js';
import { connection, deliveryQueue } from '../src/queue.js';

// The committed openapi.json is generated from the routes, never edited.
const app = await buildApp();
await app.ready();
await writeFile('openapi.json', `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
// The queue's Redis client would otherwise keep the process alive. quit()
// rather than disconnect(): BullMQ still has a listener on the connection
// and a hard disconnect surfaces as an unhandled 'Connection is closed'.
await deliveryQueue.close();
await connection.quit();
await db.$disconnect();
process.stdout.write('wrote openapi.json\n');
