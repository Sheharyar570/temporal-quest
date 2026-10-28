export const SENT: Array<[string, string]> = []; // [key, kind]: stand-in for an email provider

export async function sendEmail(user: string, kind: string, key: string): Promise<void> {
  if (!SENT.some(([k, kd]) => k === key && kd === kind)) SENT.push([key, kind]); // the key makes a retried send harmless
}
