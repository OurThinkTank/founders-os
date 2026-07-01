// ============================================================
// Founders OS — Connector Condition Spec Builder
// ============================================================
// Some conditions cannot be evaluated by server SQL because the data
// lives behind a connector the server has no handle to (a billing tool
// like Stripe for overdue_invoice) or is fetched live rather than
// stored (the feed stream for feed_keyword_match). For these,
// evaluate_triggers does NOT fire. Instead it returns a declarative
// "check to perform": which connector to ask, what to ask for, and the
// trigger id. The agent runs the connector tool, then calls
// report_trigger_observation with the matched rows and a state value;
// the server does the dedup fingerprint and fire-claim there, so firing
// stays authoritative on the server even though the agent fetched the
// data.
// ============================================================

export interface ConnectorCheck {
  trigger_id: string;
  name: string;
  condition_type: string;
  /** Connector the agent should query: whatever tool the user configured on
   *  the trigger (a billing tool, etc.), or the internal feed reader. */
  connector: string;
  /** Machine-readable spec of what to fetch. */
  query_spec: Record<string, unknown>;
  /** Plain instruction for the agent, including how to shape report_trigger_observation. */
  instructions: string;
}

export interface ConnectorTriggerRow {
  id: string;
  name: string;
  condition_type: string;
  connector: string | null;
  params: Record<string, unknown> | null;
}

const FEED_READER_CONNECTOR = "founders-os:feeds";

/**
 * Build the declarative check for one connector-source trigger. Throws
 * on an unknown connector condition_type so a misconfigured trigger is
 * loud rather than silently skipped.
 */
export function buildConnectorCheck(trigger: ConnectorTriggerRow): ConnectorCheck {
  const params = trigger.params ?? {};

  switch (trigger.condition_type) {
    case "overdue_invoice": {
      const days = typeof params.days === "number" ? params.days : 1;
      // The connector is whatever billing tool the user configured on the
      // trigger; Founders OS never assumes a specific vendor. It is required
      // for connector conditions (validated at create time), so this should
      // always be set.
      const connector = trigger.connector;
      if (!connector) {
        throw new Error(
          `Trigger "${trigger.name}" is an overdue_invoice watch with no connector set. Set the billing tool you use.`
        );
      }
      return {
        trigger_id: trigger.id,
        name: trigger.name,
        condition_type: "overdue_invoice",
        connector,
        query_spec: { kind: "unpaid_invoices_past_due", days },
        instructions:
          `Using the ${connector} connector, list invoices that are unpaid and past due by at least ${days} day(s). ` +
          `Then call report_trigger_observation with trigger_id "${trigger.id}", rows set to one { id } per overdue invoice ` +
          `(use the invoice id), and state set to a days-overdue summary (for example the largest days-overdue bucket). ` +
          `If there are no overdue invoices, call it with an empty rows array so the watcher records the all-clear.`,
      };
    }

    case "feed_keyword_match": {
      const keywords = Array.isArray(params.keywords) ? (params.keywords as string[]) : [];
      return {
        trigger_id: trigger.id,
        name: trigger.name,
        condition_type: "feed_keyword_match",
        connector: FEED_READER_CONNECTOR,
        query_spec: { kind: "feed_items_matching_keywords", keywords },
        instructions:
          `Call get_feed_items to read the latest feed items, then find items whose title or summary matches any of these keywords: ` +
          `${keywords.length ? keywords.join(", ") : "(no keywords configured; treat as no match)"}. ` +
          `Call report_trigger_observation with trigger_id "${trigger.id}", rows set to one { id } per matching item (use the item guid or link as the id), ` +
          `and state set to the id of the most recent matching item. If nothing matches, call it with an empty rows array.`,
      };
    }

    default:
      throw new Error(
        `Trigger "${trigger.name}" has connector condition_type "${trigger.condition_type}", which has no connector check builder.`
      );
  }
}

/** condition_types that are connector-source (server returns a check, agent reports back). */
export const CONNECTOR_CONDITION_TYPES = ["overdue_invoice", "feed_keyword_match"];
