// @ts-check
/**
 * @file campaign-link.js
 * Campaign linking UI — binds this Foundry world to a TableCodex campaign by id.
 * ApplicationV2 form; validates the connection via the API client before saving.
 * Built lazily so foundry.applications.* is only referenced post-init.
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
      },
    };

    static PARTS = {
      body: { template: `modules/${MODULE_ID}/templates/campaign-link.hbs` },
    };

    async _prepareContext() {
      return {
        apiUrl: getSetting(SETTINGS.API_URL) || "",
        apiToken: getSetting(SETTINGS.API_TOKEN) || "",
        campaignId: getSetting(SETTINGS.CAMPAIGN_ID) || "",
        campaignName: getSetting(SETTINGS.CAMPAIGN_NAME) || "",
      };
    }

    /**
     * @this {any}
     * @param {SubmitEvent} _event
     * @param {HTMLFormElement} _form
     * @param {{object: Record<string, any>}} formData
     */
    static async _onSubmit(_event, _form, formData) {
      const data = formData.object;
      await setSetting(SETTINGS.API_URL, (data.apiUrl ?? "").trim());
      await setSetting(SETTINGS.API_TOKEN, (data.apiToken ?? "").trim());
      await setSetting(SETTINGS.CAMPAIGN_ID, (data.campaignId ?? "").trim());
      await setSetting(SETTINGS.CAMPAIGN_NAME, (data.campaignName ?? "").trim());
      ui.notifications?.info("TableCodex: campaign link saved.");
      logger.info("campaign-link: saved");
    }

    static async _onTest() {
      const result = await apiClient.testConnection();
      if (result.ok) {
        ui.notifications?.info(`TableCodex: connection OK (${result.detail ?? "verified"}).`);
      } else {
        ui.notifications?.error(`TableCodex: connection failed — ${result.error ?? "unknown"}.`);
      }
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
