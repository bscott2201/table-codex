import { MODULE_ID } from "../constants.js";
import { apiClient } from "../api/api-client.js";
import { getSetting, setSetting } from "../core/settings.js";
import { logger } from "../core/logger.js";

export class CampaignPickerForm extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "tablecodex-campaign-picker",
      title: "TableCodex — Select Campaign",
      template: `modules/${MODULE_ID}/templates/campaign-picker.hbs`,
      width: 440,
      height: "auto",
      closeOnSubmit: true,
    });
  }

  async getData() {
    const currentCampaignId = getSetting("campaignId") || "";
    const currentCampaignName = getSetting("campaignName") || "";
    let campaigns = [];
    let error = null;

    try {
      const result = await apiClient.getCampaigns();
      campaigns = (Array.isArray(result) ? result : []).map((c) => ({
        id: String(c.id),
        name: c.name || `Campaign ${c.id}`,
        system: c.system || null,
        selected: String(c.id) === currentCampaignId,
      }));
    } catch (err) {
      logger.warn("CampaignPicker: failed to fetch campaigns:", err);
      error = err.message;
    }

    return { campaigns, currentCampaignId, currentCampaignName, error };
  }

  async _updateObject(_event, formData) {
    const campaignId = formData.campaignId || "";
    await setSetting("campaignId", campaignId);

    if (!campaignId) {
      await setSetting("campaignName", "");
      return;
    }

    // Re-fetch to resolve the name for display.
    try {
      const campaigns = await apiClient.getCampaigns();
      const found = (Array.isArray(campaigns) ? campaigns : [])
        .find((c) => String(c.id) === campaignId);
      await setSetting("campaignName", found?.name || "");
      if (found) ui.notifications.info(`[TableCodex] Campaign set to "${found.name}".`);
    } catch {
      await setSetting("campaignName", "");
    }
  }
}
