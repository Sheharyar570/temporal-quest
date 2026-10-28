/* Use case 2 (Hard): what each Overlap Policy does when a run is still going as the next one is due. */
import { sleep } from '@temporalio/workflow';

export async function slowJob(seconds: number): Promise<string> {
  await sleep(seconds * 1000); // cancellable: a cancel request surfaces here
  return 'done';
}
