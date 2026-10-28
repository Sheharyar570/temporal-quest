/* Use case 3 (Hard): a nightly import that fans out to child workflows and keeps its history bounded with Continue-As-New. */
import { continueAsNew, executeChild, ParentClosePolicy, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as activities from './import.job.activities';

const { importPage } = proxyActivities<typeof activities>({ startToCloseTimeout: '30 seconds' });

const TOTAL_RECORDS = 100;
const PAGE_SIZE = 10;

export async function pageWorkflow(p: { page: number; delayMs: number }): Promise<number> {
  return importPage(p.page, p.delayMs);
}

export interface ImportInput {
  job: string;
  nextPage?: number;
  imported?: number; // carried across runs
  pagesPerRun?: number; // small on purpose so the test sees several runs
  pageDelayMs?: number;
  parentClose?: 'TERMINATE' | 'ABANDON' | 'REQUEST_CANCEL';
}

export async function importWorkflow(input: ImportInput): Promise<number> {
  const { job, pagesPerRun = 4, pageDelayMs = 0, parentClose = 'TERMINATE' } = input;
  let nextPage = input.nextPage ?? 0;
  let imported = input.imported ?? 0;
  const lastPage = TOTAL_RECORDS / PAGE_SIZE;
  let doneThisRun = 0;

  while (nextPage < lastPage) {
    // 2 children at a time; deterministic child IDs, so a replayed or repeated start cannot create a duplicate
    const batch = [nextPage, nextPage + 1].filter((p) => p < lastPage);
    const counts = await Promise.all(batch.map((p) =>
      executeChild(pageWorkflow, {
        workflowId: `${job}-page-${p}`,
        args: [{ page: p, delayMs: pageDelayMs }],
        parentClosePolicy: ParentClosePolicy[parentClose],
      })));
    imported += counts.reduce((a, b) => a + b, 0);
    nextPage += batch.length;
    doneThisRun += batch.length;
    // continue when the server says history is getting big (or, here, after a fixed number of pages)
    if (nextPage < lastPage && (workflowInfo().continueAsNewSuggested || doneThisRun >= pagesPerRun)) {
      await continueAsNew<typeof importWorkflow>({ ...input, nextPage, imported });
    }
  }
  return imported;
}
