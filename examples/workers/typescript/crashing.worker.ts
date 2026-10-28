/* Run a worker in its own OS process so a test can SIGKILL it. usage: node crashing.worker.js <address> <namespace> */
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './shutdown.activities';

async function main() {
  const connection = await NativeConnection.connect({ address: process.argv[2] });
  const worker = await Worker.create({
    connection, namespace: process.argv[3], taskQueue: 'render',
    workflowsPath: require.resolve('./shutdown'), activities,
  });
  console.log('ready');
  await worker.run();
}
main().catch((e) => { console.error(e); process.exit(1); });
