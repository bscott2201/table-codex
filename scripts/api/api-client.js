import { MODULE_VERSION, DEFAULT_API_BASE_URL } from "../constants.js";
import { getSetting } from "../core/settings.js";
import { logger } from "../core/logger.js";

function getBaseUrl() {
  const raw = getSetting("apiBaseUrl") || DEFAULT_API_BASE_URL;
  return raw.replace(/\/+$/, "");
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
    const message = (typeof body === "object" && body?.message)
      ? body.message
      : (typeof body === "string" ? body : `HTTP ${res.status}`);
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
    logger.error(`API request failed [${options.method ?? "GET"} ${path}]:`, err);
    throw err;
  }
}

export class TableCodexApiClient {
  // POST /api/foundry/auth/verify
  // TableCodex API contract: expects { world } payload, returns { ok, campaignId? }
  async verifyConnection(worldPayload) {
    return apiFetch("/api/foundry/auth/verify", {
      method: "POST",
      body: JSON.stringify({ world: worldPayload }),
    });
  }

  // GET /api/foundry/campaigns
  // TableCodex API contract: returns [{ id, title, ... }]
  async getCampaigns() {
    return apiFetch("/api/foundry/campaigns");
  }

  // GET /api/foundry/campaigns/:campaignId/sessions
  // TableCodex API contract: returns [{ id, title, ... }]
  async getSessions(campaignId) {
    return apiFetch(`/api/foundry/campaigns/${encodeURIComponent(campaignId)}/sessions`);
  }

  // POST /api/foundry/campaigns/:campaignId/sessions
  // TableCodex API contract: expects { title, world, ... }, returns { id, ... }
  async createSession(campaignId, payload) {
    return apiFetch(`/api/foundry/campaigns/${encodeURIComponent(campaignId)}/sessions`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  // POST /api/foundry/sessions/:sessionId/capture/start
  // TableCodex API contract: expects { world, captureMode, ... }, returns { captureId, ... }
  async startCapture(sessionId, payload) {
    return apiFetch(`/api/foundry/sessions/${encodeURIComponent(sessionId)}/capture/start`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  // POST /api/foundry/sessions/:sessionId/events/batch
  // TableCodex API contract: expects { batchId, captureId, world, events[] }
  async sendEventBatch(sessionId, payload) {
    return apiFetch(`/api/foundry/sessions/${encodeURIComponent(sessionId)}/events/batch`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  // POST /api/foundry/sessions/:sessionId/capture/end
  // TableCodex API contract: expects { captureId, eventCount, ... }
  async endCapture(sessionId, payload) {
    return apiFetch(`/api/foundry/sessions/${encodeURIComponent(sessionId)}/capture/end`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }
}

export const apiClient = new TableCodexApiClient();
