import { MODULE_VERSION, DEFAULT_API_BASE_URL } from "../constants.js";
import { getSetting } from "../core/settings.js";
import { logger } from "../core/logger.js";

function getBaseUrl() {
  const raw = getSetting("apiBaseUrl") || DEFAULT_API_BASE_URL;
  // Strip trailing slashes and a trailing /api segment so callers that enter
  // "https://example.com/api" and our own "/api/..." paths don't double up.
  return raw.replace(/\/+$/, "").replace(/\/api$/i, "");
}

function getApiKey() {
  return getSetting("apiKey") || "";
}

function buildHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    "X-TableCodex-Source": "foundry-v14",
    "X-TableCodex-Module-Version": MODULE_VERSION,
  };
}

async function handleResponse(res) {
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message = (typeof body === "object")
      ? (body?.message ?? body?.error ?? `HTTP ${res.status}`)
      : (typeof body === "string" && body.trim() && !body.trim().startsWith("<") ? body.trim() : `HTTP ${res.status}`);
    throw new Error(`TableCodex API error ${res.status}: ${message}`);
  }
  return body;
}

async function apiFetch(path, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Missing TableCodex API key. Configure it in module settings.");
  const url = `${getBaseUrl()}${path}`;
  try {
    const res = await fetch(url, {
      ...options,
      headers: buildHeaders(apiKey),
    });
    return await handleResponse(res);
  } catch (err) {
    // "Failed to fetch" is the browser's CORS/network error — give a clear message.
    if (err instanceof TypeError && err.message === "Failed to fetch") {
      const friendly = new Error(
        `Cannot reach the TableCodex API (${getBaseUrl()}). ` +
        `This is usually a CORS error — the API must allow requests from your Foundry origin. ` +
        `Check the browser console Network tab for a blocked preflight request.`
      );
      logger.error(`API request failed [${options.method ?? "GET"} ${path}]:`, friendly.message);
      throw friendly;
    }
    logger.error(`API request failed [${options.method ?? "GET"} ${path}]:`, err);
    throw err;
  }
}

export class TableCodexApiClient {
  // GET /api/campaigns → [{ id, name, ... }]
  async getCampaigns() {
    return apiFetch("/api/campaigns");
  }

  // GET /api/campaigns/:campaignId/sessions → [{ id, title, sessionNumber, status, ... }]
  async getSessions(campaignId) {
    return apiFetch(`/api/campaigns/${encodeURIComponent(campaignId)}/sessions`);
  }

  // POST /api/campaigns/:campaignId/sessions
  // Required body: { title: string, sessionNumber: number }
  // Returns: { id, campaignId, sessionNumber, title, status, ... }
  async createSession(campaignId, payload) {
    return apiFetch(`/api/campaigns/${encodeURIComponent(campaignId)}/sessions`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  // POST /api/campaigns/:campaignId/sessions/:sessionId/vtt-events/batch
  // Body: { events: VttEvent[] } (1–500 events per request)
  // VttEvent fields: sequenceIndex, eventType, eventSummary, visibility, confidence,
  //   actor?, target?, rawLine?, eventDataJson?, isImportant?
  async sendEventBatch(campaignId, sessionId, events) {
    return apiFetch(
      `/api/campaigns/${encodeURIComponent(campaignId)}/sessions/${encodeURIComponent(sessionId)}/vtt-events/batch`,
      {
        method: "POST",
        body: JSON.stringify({ events }),
      }
    );
  }
}

export const apiClient = new TableCodexApiClient();
