/* One machine = one OS process: it polls the shared queue (the lookup) and, unless it is a "ghost", its own queue.
 * usage: node routing.host.js <address> <namespace> <name> <logFile> [ghost] */
import { appendFileSync } from 'node:fs';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Host } from './routing.activities';

async function main() {
  const [address, namespace, name, logFile, ghost] = process.argv.slice(2);
  const host = new Host(name, (step) => appendFileSync(logFile, `${step}\n`));
  const connection = await NativeConnection.connect({ address });
  const workers = [Worker.create({ connection, namespace, taskQueue: 'media', activities: host.sharedActivities() })];
  if (!ghost) workers.push(Worker.create({ connection, namespace, taskQueue: host.queue, activities: host.hostActivities() }));
  const running = await Promise.all(workers);
  console.log('ready');
  await Promise.all(running.map((w) => w.run()));
}
main().catch((e) => { console.error(e); process.exit(1); });
