import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as activities from './approval.activities';

export const TASK_QUEUE = 'approvals';

const { notifyApprover } = proxyActivities<typeof activities>({ startToCloseTimeout: '30 seconds' });

export interface ApprovalRequest {
  requestId: string;
  amount: number;
  approvers: string[]; // escalation chain, lowest level first
  levelTimeoutHours?: number;
}
export interface Decision {
  approver: string;
  approved: boolean;
  comment?: string;
}

export const decideSignal = defineSignal<[Decision]>('decide');
export const statusQuery = defineQuery<{ waitingOn: string | null; audit: string[] }>('status');

export async function approvalChainWorkflow(req: ApprovalRequest): Promise<string> {
  let current: string | null = null;
  let decision: Decision | undefined;
  const audit: string[] = [];

  // Handlers only RECORD. Authorisation is checked here, decisions are made below.
  setHandler(decideSignal, (d) => {
    if (d.approver !== current || decision !== undefined) {
      audit.push('ignored decision from ' + d.approver);
      return;
    }
    decision = d;
    audit.push(d.approver + ' ' + (d.approved ? 'approved' : 'rejected'));
  });
  setHandler(statusQuery, () => ({ waitingOn: current, audit }));

  for (const approver of req.approvers) {
    current = approver;
    decision = undefined;
    await notifyApprover(approver, req.requestId);

    const answered = await condition(() => decision !== undefined, (req.levelTimeoutHours ?? 4) * 3600 * 1000);
    if (!answered) {
      audit.push(approver + ' timed out, escalating');
      continue; // next approver in the chain
    }
    const decided = decision as Decision | undefined; // set by the signal handler
    return decided?.approved ? 'approved' : 'rejected';
  }

  current = null;
  return 'expired';
}
