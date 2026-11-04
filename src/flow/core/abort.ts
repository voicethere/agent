/**
 * Abort reason the interpreter uses when it cancels an in-flight call (stop,
 * another effect failed). Timeouts abort without it.
 */
export const FLOW_CALL_CANCELLED = "flow call cancelled";

/** An `AbortError` so fetch and vendor SDKs treat it like a plain abort. */
export function cancelReason(): DOMException {
  return new DOMException(FLOW_CALL_CANCELLED, "AbortError");
}

/** True when the signal was aborted by the interpreter's cancel, not a timeout. */
export function wasCancelled(signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    signal.reason instanceof DOMException &&
    signal.reason.message === FLOW_CALL_CANCELLED
  );
}
