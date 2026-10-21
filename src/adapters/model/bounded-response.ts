import { ModelFailure } from "../../troubleshooting/application/model-failure.js";

import { transportFailure } from "./transport-failure.js";

const MAX_RESPONSE_BYTES = 1_048_576;

export function boundedResponse(response: Response, failed: (error: Error) => void, signal: AbortSignal): { response: Response; finished: Promise<void> } {
  if (!response.body) throw new ModelFailure("schema_mismatch");
  const reader = response.body.getReader();
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let consumerClosed = false;
  const finished = Promise.withResolvers<void>();
  void finished.promise.catch(() => {});
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          for (;;) {
            let result: ReadableStreamReadResult<Uint8Array>;
            try { result = await reader.read(); }
            catch (error) { throw transportFailure(error, true, signal); }
            if (result.done) break;
            bytes += result.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) throw new ModelFailure("schema_mismatch");
            try { utf8.decode(result.value, { stream: true }); } catch { throw new ModelFailure("schema_mismatch"); }
            if (!consumerClosed) controller.enqueue(result.value);
          }
          try { utf8.decode(); } catch { throw new ModelFailure("schema_mismatch"); }
          finished.resolve();
          if (!consumerClosed) controller.close();
        } catch (failure) {
          const error = failure instanceof Error ? failure : new ModelFailure("schema_mismatch");
          failed(error); finished.reject(error);
          if (!consumerClosed) controller.error(error);
          void reader.cancel().catch(() => {});
        } finally { reader.releaseLock(); }
      })();
    },
    // A codec completion sentinel cannot skip validation of the remaining bounded wire body.
    cancel() { consumerClosed = true; },
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length"); headers.delete("content-encoding");
  return { response: new Response(body, { status: response.status, statusText: response.statusText, headers }), finished: finished.promise };
}
