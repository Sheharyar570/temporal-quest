/* Use case 2 (Hard): deploying and crashing workers without losing work. */
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from './shutdown.activities';

const { render } = proxyActivities<typeof activities>({
  startToCloseTimeout: '60 seconds',
  heartbeatTimeout: '2 seconds',
  retry: { initialInterval: '1 second' },
});

export async function renderWorkflow(job: string, workDir: string, seconds: number): Promise<string> {
  return render(job, workDir, seconds);
}
