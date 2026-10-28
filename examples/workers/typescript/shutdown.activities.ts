import { Context, heartbeat } from '@temporalio/activity';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function render(job: string, workDir: string, seconds: number): Promise<string> {
  const { attempt } = Context.current().info;
  // one marker file per attempt, so the test can see which attempt ran where
  writeFileSync(join(workDir, `${job}.attempt${attempt}.started`), String(process.pid));
  try {
    for (let i = 0; i < Math.floor(seconds / 0.2); i++) {
      await Context.current().sleep(200);
      heartbeat(); // lets the service notice a dead worker in seconds instead of minutes
    }
  } catch (e) {
    // worker shutdown (grace period over) or workflow cancel. Record the reason, then re-throw.
    const reason = Context.current().cancellationSignal.reason;
    writeFileSync(join(workDir, `${job}.attempt${attempt}.cancelled`), String((reason as Error)?.message ?? reason));
    throw e;
  }
  return `${job}:attempt${attempt}`;
}
