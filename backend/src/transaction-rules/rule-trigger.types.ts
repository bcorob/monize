/**
 * When a rule runs (design section 3, decision 1). A manual run is an action
 * on the rule, not a trigger, so it is not in this list.
 */
export const RULE_TRIGGERS = ["create", "import"] as const;
export type RuleTrigger = (typeof RULE_TRIGGERS)[number];
