export async function postLedgerEntry(accountId: string, eventId: string, amount: number): Promise<void> {
  // In production: INSERT ... ON CONFLICT (event_id) DO NOTHING  (idempotent write).
  console.log('ledger', accountId, eventId, amount);
}
