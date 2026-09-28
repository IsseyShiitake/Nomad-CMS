/* Greeting queue/bus: module-level so `greet()` works from anywhere,
   including outside React. The GreetingHost component drains the queue
   and renders each request one at a time. No React imports here. */

export type GreetingLocale = 'en' | 'fr';

export interface GreetingRequest {
  name: string;
  locale: GreetingLocale;
  onDone?: () => void;
}

const queue: GreetingRequest[] = [];
const listeners = new Set<() => void>();

/** Queue a greeting and notify the host (if one is mounted). */
export function greet(request: GreetingRequest): void {
  queue.push(request);
  for (const notify of [...listeners]) {
    notify();
  }
}

/** Subscribe to new-greeting notifications; returns an unsubscribe function. */
export function subscribeGreetingHost(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Pull the next queued greeting, if any. */
export function takeNextGreeting(): GreetingRequest | null {
  return queue.shift() ?? null;
}

export { GreetingHost } from './GreetingHost';
