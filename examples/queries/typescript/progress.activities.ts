export interface ChunkResult {
  ok: number;
  failed: number;
  errors: string[];
}

export async function importChunk(start: number, size: number): Promise<ChunkResult> {
  // In production: read records [start, start+size) and write them to the target system.
  await new Promise((r) => setTimeout(r, 150));
  const bad: number[] = [];
  for (let i = start; i < start + size; i++) if (i % 37 === 0) bad.push(i); // pretend every 37th record is invalid
  return { ok: size - bad.length, failed: bad.length, errors: bad.map((i) => 'record ' + i + ': invalid email') };
}
