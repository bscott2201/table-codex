import { INACTIVITY_TIMEOUT_MS } from "../constants.js";
import { logger } from "./logger.js";

class InactivityMonitor {
  constructor() {
    this._timer = null;
    this._active = false;
    // Populated by capture-manager to avoid a circular import.
    this._onStop = null;
  }

  start(onStop) {
    this._active = true;
    this._onStop = onStop;
    this._reset();
    logger.log("InactivityMonitor started.");
  }

  stop() {
    this._active = false;
    this._onStop = null;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    logger.log("InactivityMonitor stopped.");
  }

  // Call this every time an event is logged to reset the idle clock.
  ping() {
    if (!this._active) return;
    this._reset();
  }

  _reset() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._onInactive(), INACTIVITY_TIMEOUT_MS);
  }

  async _onInactive() {
    if (!this._active) return;
    logger.log("InactivityMonitor: no activity for 20 minutes.");

    const stillGoing = await Dialog.confirm({
      title: "Session Still Active?",
      content: `
        <p>No activity has been logged in the last <strong>20 minutes</strong>.</p>
        <p>Is your session still ongoing?</p>
      `,
      yes: () => true,
      no: () => false,
      defaultYes: true,
    });

    if (!this._active) return; // Session may have been stopped while dialog was open.

    if (stillGoing) {
      this._reset();
    } else if (this._onStop) {
      await this._onStop();
    }
  }
}

export const inactivityMonitor = new InactivityMonitor();
