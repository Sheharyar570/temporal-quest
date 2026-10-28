export interface AuthRequest {
  cardToken: string;
  amount: number;
}
export interface AuthResult {
  approved: boolean;
  authId: string;
  reason: string;
}

export async function authorizeCard(req: AuthRequest): Promise<AuthResult> {
  // In production: call the payment provider.
  if (req.cardToken === 'tok_declined') return { approved: false, authId: '', reason: 'insufficient funds' };
  return { approved: true, authId: 'auth-' + req.cardToken, reason: '' };
}

export async function capturePayment(authId: string): Promise<void> {
  console.log('captured', authId);
}

export async function sendReceipt(orderId: string): Promise<void> {
  console.log('receipt for', orderId);
}
