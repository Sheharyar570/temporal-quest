export const DONE: number[] = []; // page numbers processed (stand-in for rows written)
export const PAGE_SIZE = 10;

export async function importPage(page: number, delayMs: number): Promise<number> {
  await new Promise((r) => setTimeout(r, delayMs));
  DONE.push(page);
  return PAGE_SIZE;
}
