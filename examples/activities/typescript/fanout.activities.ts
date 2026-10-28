import { ApplicationFailure } from '@temporalio/activity';

class NotFound extends Error {}
class TooManyRequests extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('429');
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stand-in for a third-party API that tolerates only a few concurrent callers. */
class FakeApi {
  inFlight = 0;
  maxInFlight = 0;
  calls = 0;
  throttleOnce = new Set<string>();
  latencyMs = 50;

  async getProfile(userId: string): Promise<string> {
    this.calls++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await sleep(this.latencyMs);
      if (userId.startsWith('missing')) throw new NotFound(userId);
      if (this.throttleOnce.delete(userId)) throw new TooManyRequests(3); // the API says: come back in 3 seconds
      return 'user ' + userId;
    } finally {
      this.inFlight--;
    }
  }
}
export const api = new FakeApi();

export async function fetchProfile(userId: string): Promise<string> {
  try {
    return await api.getProfile(userId);
  } catch (e) {
    if (e instanceof NotFound) {
      throw ApplicationFailure.create({ message: userId + ' does not exist', type: 'NotFound', nonRetryable: true });
    }
    if (e instanceof TooManyRequests) {
      throw ApplicationFailure.create({ message: '429', type: 'RateLimited', nextRetryDelay: e.retryAfterSeconds * 1000 });
    }
    throw e;
  }
}
