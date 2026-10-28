export class Host {
  readonly queue: string;
  readonly disk = new Map<string, string>(); // files live here: only this host can see them
  readonly log: Array<[string, string]> = []; // [step, host]
  constructor(readonly name: string, private sink?: (step: string) => void) { this.queue = `media-host-${name}`; }
  private record(step: string) { this.log.push([step, this.name]); this.sink?.(step); }

  /** The activities this host registers on its own queue. */
  hostActivities() {
    return {
      download: async (name: string): Promise<string> => {
        const path = `/tmp/${name}`;
        this.disk.set(path, 'raw');
        this.record('download');
        return path;
      },
      process: async (path: string): Promise<string> => {
        if (this.disk.get(path) !== 'raw') throw new Error(`${path} is not on ${this.name}`); // fails on any other host
        this.disk.set(path, 'processed');
        this.record('process');
        return path;
      },
      upload: async (path: string): Promise<string> => {
        if (this.disk.get(path) !== 'processed') throw new Error(`${path} is not on ${this.name}`);
        this.record('upload');
        return this.name;
      },
    };
  }

  /** Registered on the shared queue: whichever host picks it up tells the workflow how to reach it. */
  sharedActivities() {
    return { getHostQueue: async (): Promise<string> => this.queue };
  }
}

export async function renderOnGpu(name: string): Promise<string> { return `rendered:${name}`; }
