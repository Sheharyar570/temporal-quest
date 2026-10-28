export const CALLS: string[] = [];

export async function charge(_order: string): Promise<void> { CALLS.push('charge'); }
export async function fraudCheck(_order: string): Promise<void> { CALLS.push('fraud_check'); }
export async function ship(_order: string): Promise<void> { CALLS.push('ship'); }
