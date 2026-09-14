/**
 * Cooperative cancellation for long-running IndexBot pipelines.
 */

export function createCancelToken() {
  return {cancelled: false};
}

/**
 * @param {{ cancelled?: boolean } | null | undefined} token
 */
export function throwIfCancelled(token) {
  if (token?.cancelled) {
    const err = new Error('Cancelled');
    err.code = 'CANCELLED';
    throw err;
  }
}

/**
 * @param {{ cancelled?: boolean } | null | undefined} token
 * @returns {() => boolean}
 */
export function shouldCancelFn(token) {
  return () => Boolean(token?.cancelled);
}
