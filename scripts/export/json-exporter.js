// @ts-check
/**
 * @file json-exporter.js
 * Phase 6: serializes the full session payload (raw events + reconstruction) to
 * JSON and triggers a download. The JSON is the highest-fidelity export and is
 * the same shape pushed to the upload queue.
 */

import { logger } from "../core/logger.js";
import { buildPayload, sessionFilename, downloadFile } from "./payload.js";

class JsonExporter {
  /**
   * Build the JSON string for a payload.
   * @param {import("../bus/event-envelope.js").TelemetryEvent[]} [events]
   * @returns {{ json: string, payload: import("./payload.js").SessionPayload }}
   */
  serialize(events) {
    const payload = buildPayload(events);
    return { json: JSON.stringify(payload, null, 2), payload };
  }

  /** Build the payload and trigger a file download. */
  download(events) {
    const { json, payload } = this.serialize(events);
    downloadFile(json, sessionFilename(payload, "json"), "application/json");
    logger.info(`json-exporter: exported ${payload.rawEvents.length} event(s)`);
    return payload;
  }
}

export const jsonExporter = new JsonExporter();
export { JsonExporter };
