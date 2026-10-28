export async function createOrder(customerId: string, items: string[]): Promise<string> {
  // In production: write the order to your database / call the order service.
  return 'order-' + customerId + '-' + items.length;
}

export async function sendAbandonedCartEmail(customerId: string): Promise<void> {
  // In production: call your email provider.
  console.log('reminder sent to', customerId);
}
