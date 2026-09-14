# Barbershop OS — Build-first session rules

User direction, 2026-09-14: stop repeated long planning/notes cycles; plan briefly and build connected features immediately. Keep old documents as references, not mandatory rewriting tasks. This supersedes D-018's wait-after-E1 workflow; no new acceptance pause for each ordinary local slice.

## Start and deliver

1. Read the latest short entry at the top of `docs/PROGRESS.md`, inspect git status and affected source/tests. Consult older plans/decisions only when relevant; do not reread or rewrite the whole document set every turn.
2. State a small concrete delivery, then implement it in the existing app. User's 100-area modern-system brief: https://www.genspark.ai/api/files/s/sRhSuhAH. Build overlapping requirements once; preserve existing requirement IDs. Aspirations and illustrative commercial policies are not proof of implementation.
3. Test changed flows, persistence, failure recovery, keyboard and responsive layouts. Include phone/tablet/desktop, landscape, short screens, long content and zoom where relevant. Inspect actual browser images. Representative widths are not certification of every device.
4. Independent inspection/test work may run in parallel; one coordinated owner changes shared APIs/schema/source. Never build or migrate during regression; use isolated fictional tenants.
5. Keep one short progress entry (changes, evidence, next/blockers), a concise README update and a clean commit. No repeated multi-document plans, new notes bundles or documentation-only turns unless requested. Keep prior records rather than deleting history.

## Preserve these boundaries

- One product UI: original shell, calendar/navigation and matte forest/sage/teal palette. `/workspace` is the connected owner-test app; `/preview/*` are labelled fixture references. Do not create another competing main app or a fake customer/staff login.
- Local D1 and fictional data only. No production deployment, provider activation, charges, messages, bank transfers or public GitHub push. Development preview is not production.
- Model A: each shop receives haircut money; owners pay barbers externally. Future manual pay-runs calculate/export/record, not hold wallets or initiate barber transfers. SaaS subscription money is separate.
- Hono/React/Cloudflare project under `/home/user/webapp`, main branch. Retain data, migrations and shared server authority. No framework/database reset.
- Tenant/role checks belong on the server; browser capability is not production identity. Current quotes and atomic D1 collision guards apply to all new bookings. Immutable historical snapshots survive moves/catalogue changes. Never infer payment from completion.
- Secrets never enter frontend/git/logs. No fabricated save/provider success. Preserve inputs on failed saves, protect dirty/pending actions and verify before retrying ambiguous mutations.
- Five existing migrations, including two distinct `0002_*` files, remain intact. Next prefix 0005. Identity/customer ownership, finance, providers and device acceptance remain separate unfinished work.
- New marketing/review/consent, commission, recurring-billing and multi-location features need explicit safe rules when implemented; do not copy example policies blindly. Do not gate public-review invitations on positive feedback.

These project rules establish continuity, not higher-priority instructions or permanent model retraining.
