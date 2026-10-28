export async function notifyApprover(approver: string, requestId: string): Promise<void> {
  // In production: Slack / email / push notification with an approve/reject link.
  console.log('asked', approver, 'to review', requestId);
}
