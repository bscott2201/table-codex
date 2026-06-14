// @ts-check
/**
 * @file campaign-link.js
 * Campaign linking UI — binds this Foundry world to a TableCodex campaign.
 * Supports testing the connection and fetching the campaign list from the API so
 * the user picks from a dropdown instead of typing an id by hand. Falls back to
 * manual id/name entry when no campaigns have been loaded. ApplicationV2 form,
 * built lazily so foundry.applications.* is only referenced post-init.
 */

import { MODULE_ID, SETTINGS } from "../core/constants.js";
import { logger } from "../core/logger.js";
import { setSetting, getSetting } from "../core/settings.js";
import { apiClient } from "../export/api-client.js";

let _instance = null;
let _Class = null;

function getClass() {
  if (_Class) return _Class;
  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

  class CampaignLinkApp extends HandlebarsApplicationMixin(ApplicationV2) {
    /** @type {{id:string,name:string}[]} fetched campaigns (empty until loaded) */
    _campaigns = [];
    /** @type {{ok:boolean,message:string}|null} last test/load result */
    _status = null;

    static DEFAULT_OPTIONS = {
      id: "tablecodex-campaign-link",
      tag: "form",
      window: { title: "Link TableCodex Campaign", icon: "fa-solid fa-link" },
      position: { width: 460, height: "auto" },
      form: {
        handler: CampaignLinkApp._onSubmit,
        submitOnChange: false,
        closeOnSubmit: false,
      },
      actions: {
        testConnection: CampaignLinkApp._onTest,
        loadCampaigns: CampaignLinkApp._onLoadCampaigns,
      },
    };

    static PARTS = {
      body: { template: `modules/${MODULE_ID}/templates/campaign-link.hbs` },
    };

    async _prepareContext() {
      const selectedId = getSetting(SETTINGS.CAMPAIGN_ID) || "";
      return {
        apiUrl: getSetting(SETTINGS.API_URL) || "",
        apiToken: getSetting(SETTINGS.API_TOKEN) || "",
        campaignId: selectedId,
        campaignName: getSetting(SETTINGS.CAMPAIGN_NAME) || "",
        campaigns: this._campaigns,
        hasCampaigns: this._campaigns.length > 0,
        status: this._status,
      };
    }

    /**
     * Persist the API URL/token currently typed in the form so the API client
     * (which reads from settings) uses fresh values before a test/fetch.
     * @this {any}
     */
    async _syncCredsFromForm() {
      const root = this.element;
      if (!root) return;
      const url = root.querySelector('[name="apiUrl"]')?.value ?? "";
      const token = root.querySelector('[name="apiToken"]')?.value ?? "";
      await setSetting(SETTINGS.API_URL, url.trim());
      await setSetting(SETTINGS.API_TOKEN, token.trim());
    }

    /**
     * @this {any}
     * @param {SubmitEvent} _event
     * @param {HTMLFormElement} _form
     * @param {{object: Record<string, any>}} formData
     */
    static async _onSubmit(_event, _form, formData) {
      const data = formData.object;
      const campaignId = (data.campaignId ?? "").trim();
      // Derive the name from the fetched list when a dropdown was used;
      // otherwise fall back to the manual name field.
      const matched = this._campaigns.find((c) => c.id === campaignId);
      const campaignName = matched?.name ?? (data.campaignName ?? "").trim();

      await setSetting(SETTINGS.API_URL, (data.apiUrl ?? "").trim());
      await setSetting(SETTINGS.API_TOKEN, (data.apiToken ?? "").trim());
      await setSetting(SETTINGS.CAMPAIGN_ID, campaignId);
      await setSetting(SETTINGS.CAMPAIGN_NAME, campaignName);
      ui.notifications?.info("TableCodex: campaign link saved.");
      logger.info(`campaign-link: saved (${campaignId || "none"})`);
    }

    /** @this {any} */
    static async _onTest() {
      await this._syncCredsFromForm();
      const result = await apiClient.testConnection();
      this._status = result.ok
        ? { ok: true, message: `Connected (${result.detail ?? "verified"}).` }
        : { ok: false, message: result.error ?? "Connection failed." };
      if (result.ok) ui.notifications?.info(`TableCodex: ${this._status.message}`);
      else ui.notifications?.error(`TableCodex: ${this._status.message}`);
      this.render();
    }

    /** @this {any} Fetch the campaign list into the dropdown. */
    static async _onLoadCampaigns() {
      await this._syncCredsFromForm();
      const result = await apiClient.listCampaigns();
      if (result.ok) {
        this._campaigns = result.data ?? [];
        this._status = {
          ok: true,
          message: `Loaded ${this._campaigns.length} campaign(s).`,
        };
        if (this._campaigns.length === 0) {
          ui.notifications?.warn("TableCodex: no campaigns found for this token.");
        }
      } else {
        this._campaigns = [];
        this._status = { ok: false, message: result.error ?? "Failed to load campaigns." };
        ui.notifications?.error(`TableCodex: ${this._status.message}`);
      }
      this.render();
    }
  }

  _Class = CampaignLinkApp;
  return _Class;
}

/** Open the campaign-link window. */
export function openCampaignLink() {
  try {
    const Cls = getClass();
    if (!_instance) _instance = new Cls();
    _instance.render(true);
  } catch (err) {
    logger.error("campaign-link: failed to open", err);
  }
}
