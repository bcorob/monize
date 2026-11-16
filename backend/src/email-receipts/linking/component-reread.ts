/**
 * The emails a default "process in bulk" and a profile's `reprocessableCount`
 * add to the processable statuses (linked receipts spec 9): an email whose
 * request was applied (status `review`, not yet a component) and that an
 * approved `component` profile covers. Read again, it becomes a component and
 * keeps its transaction and its applied request. The SQL is written once, here,
 * so the batch, its remaining count and the profile's count cannot drift.
 */

/** `r` is an `email_receipts` row: stored as `review`, no link value, request applied. */
export function appliedReviewClause(r: string): string {
  return `(${r}.status = 'review'
            AND ${r}.link_key IS NULL
            AND EXISTS (SELECT 1
                          FROM ai_review_requests applied_rq
                         WHERE applied_rq.id = ${r}.ai_review_request_id
                           AND applied_rq.user_id = ${r}.user_id
                           AND applied_rq.status = 'applied'))`;
}

/** The sender domain `r.from_domain` is the domain `d` or one of its sub-domains (the module's own rule). */
export function coveredByDomainSql(r: string, d: string): string {
  return `(${r}.from_domain = ${d}
            OR right(${r}.from_domain, length(${d}) + 1) = '.' || ${d})`;
}

/** `r` is an applied `review` email that some APPROVED `component` profile of the same user covers. */
export function appliedComponentRereadClause(r: string): string {
  return `(${appliedReviewClause(r)}
            AND EXISTS (SELECT 1
                          FROM email_receipt_parsers cp
                          CROSS JOIN LATERAL unnest(cp.from_domains) AS cd(domain)
                         WHERE cp.user_id = ${r}.user_id
                           AND cp.status = 'approved'
                           AND cp.definition->>'role' = 'component'
                           AND ${coveredByDomainSql(r, "cd.domain")}))`;
}
