// @ts-check
/**
 * @file markdown-exporter.js
 * Phase 6: renders a human-readable Markdown session log from the reconstruction
 * — session header, actor summary table, combat-by-combat timeline, and a flat
 * event timeline. Pure string building over the payload.
 */

import { logger } from "../core/logger.js";
import { buildPayload, sessionFilename, downloadFile } from "./payload.js";

class MarkdownExporter {
  /**
   * Build the Markdown string for a payload.
   * @param {import("../bus/event-envelope.js").TelemetryEvent[]} [events]
   * @returns {{ md: string, payload: import("./payload.js").SessionPayload }}
   */
  serialize(events) {
    const payload = buildPayload(events);
    return { md: this.renderFromPayload(payload), payload };
  }

  /**
   * Render Markdown from an already-built payload (no reconstruction rebuild).
   * Used by the upload queue to attach a transcript without recomputing.
   * @param {import("./payload.js").SessionPayload} payload
   * @returns {string}
   */
  renderFromPayload(payload) {
    const r = payload.reconstruction;
    const lines = [];

    lines.push(`# TableCodex Session Log`);
    lines.push("");
    lines.push(`- **Session:** ${payload.session.id ?? "—"}`);
    if (payload.session.campaignName) lines.push(`- **Campaign:** ${payload.session.campaignName}`);
    lines.push(`- **World:** ${payload.session.worldName ?? payload.session.worldId ?? "—"}`);
    lines.push(`- **Started:** ${r.startedAt ?? "—"}`);
    lines.push(`- **Ended:** ${r.endedAt ?? "—"}`);
    lines.push(`- **Events captured:** ${r.summary.eventCount}`);
    lines.push("");

    // Actor summary
    lines.push(`## Actors`);
    lines.push("");
    lines.push(`| Actor | HP | Damage taken | Healing | Conditions |`);
    lines.push(`| --- | --- | --- | --- | --- |`);
    for (const a of Object.values(r.actors)) {
      const hp = a.hp.value != null ? `${a.hp.value}/${a.hp.max ?? "?"}` : "—";
      lines.push(
        `| ${a.name ?? a.actorId} | ${hp} | ${a.damageTaken} | ${a.healingTaken} | ${a.conditions.join(", ") || "—"} |`,
      );
    }
    lines.push("");

    // Combats
    if (r.combats.length) {
      lines.push(`## Combats`);
      lines.push("");
      r.combats.forEach((combat, i) => {
        lines.push(`### Combat ${i + 1}`);
        lines.push(`- Started: ${combat.startedAt ?? "—"} · Ended: ${combat.endedAt ?? "—"}`);
        lines.push("");
        for (const round of combat.rounds) {
          lines.push(`#### Round ${round.round}`);
          for (const turn of round.turns) {
            lines.push(`- **${turn.name ?? "Unknown"}'s turn**`);
            for (const action of turn.actions) {
              lines.push(`  - ${this._action(action)}`);
            }
          }
          lines.push("");
        }
      });
    }

    // Flat timeline
    lines.push(`## Timeline`);
    lines.push("");
    for (const entry of r.timeline) {
      const t = entry.timestamp ? entry.timestamp.slice(11, 19) : "--:--:--";
      lines.push(`- \`${t}\` ${entry.summary}`);
    }
    lines.push("");

    return lines.join("\n");
  }

  /** One-line description of a combat action. */
  _action(action) {
    const m = action.metadata ?? {};
    switch (action.eventType) {
      case "actor.hp.change":
        return `${m.docName ?? "actor"} ${m.direction} ${Math.abs(m.valueDelta ?? 0)} HP`;
      case "dnd5e.spell.cast":
        return `cast **${m.spellName}** (level ${m.castLevel})`;
      case "dnd5e.weapon.attack":
        return `${m.kind} with **${m.itemName ?? "weapon"}**`;
      case "dnd5e.activity.use":
        return `used **${m.itemName ?? m.activityName ?? "activity"}**`;
      case "roll":
        return `rolled ${m.formula} = **${m.total}**`;
      case "midi.workflow":
        return `Midi: **${m.itemName}** hit ${(m.targets ?? []).filter((t) => t.hit).length} target(s)`;
      default:
        return action.eventType;
    }
  }

  /** Build the Markdown and trigger a file download. */
  download(events) {
    const { md, payload } = this.serialize(events);
    downloadFile(md, sessionFilename(payload, "md"), "text/markdown");
    logger.info("markdown-exporter: exported session log");
    return payload;
  }
}

export const markdownExporter = new MarkdownExporter();
export { MarkdownExporter };
