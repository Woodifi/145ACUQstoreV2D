# QStore IMS v2 — Roadmap

> **Owner:** Sean Scales
> **Last updated:** 2026-05-29
> **Status key:** ✅ Done · 🔄 In progress · 📋 Planned · 💡 Considering

---

## Current Status

**v2.3.1** — Feature-complete. The product is in active maintenance and distribution.
All planned IMS features are shipped. Focus is now on licensing, commercial infrastructure, and marketing.

---

## Now (Active)

| Status | Item |
|---|---|
| ✅ | Ed25519 licensing system — trial/grace/restricted enforcement |
| ✅ | Subscription key activation in Settings |
| ✅ | First lifetime key issued (422 ACU StMichaels College) |
| ✅ | Distro builds → unit subdirectories |
| ✅ | PDF worksheets wrap long item names |

---

## Next (Planned)

| Priority | Item | Notes |
|---|---|---|
| High | **Register V2 as product in Platform Core** | Product slug `qstore-ims-v2`; plans: annual, lifetime |
| High | **Replace local Ed25519 with Platform Core SDK** | `platform.licensing.validate()` replaces `src/license.js` |
| High | **Marketing website** | ChatGPT-led; links to Platform Core `portal-web` for subscriptions |
| Medium | **Online key activation portal** | Unit OCs subscribe online → key auto-generated → download |
| Medium | **V2 → V3 upgrade path** | Settings option to export V2 data in V3-compatible format |

---

## Platform Core Integration Plan

When Platform Core is deployed to production:

1. Register product `qstore-ims-v2` in Admin Dashboard
2. Create plans: `v2-annual` (12-month), `v2-lifetime` (perpetual)
3. Install `@platform-core/sdk` in V2
4. Replace `src/license.js` Ed25519 local validation with `platform.licensing.validate(unitId)`
5. Map TRIAL/ACTIVE/GRACE/RESTRICTED → Platform Core licence states
6. Configure webhooks: `subscription.cancelled` → RESTRICTED; `subscription.renewed` → ACTIVE
7. Subscription portal: link to Platform Core `portal-web` (port 3000)

See `platform-core/docs/ONBOARDING_NEW_PRODUCT.md` for the 6-step integration process.

---

## Future Considerations

| Status | Item | Notes |
|---|---|---|
| 💡 | Multi-device conflict resolution | V2 sync is LWW snapshot — V3 has event-log sync |
| 💡 | Photo cloud sync | Currently excluded (too large); would need chunked upload |
| 💡 | Offline PWA wrapper | Service worker for true PWA install |
| 💡 | Unit-to-unit transfer receipts | PDF documentation for equipment transfers between units |

---

## What Is NOT Planned for V2

The following features are intentionally V3-only to maintain tier differentiation:

- Accounting module (income/expense, invoices, bank reconciliation, GST/BAS)
- Event-log sync (field-level LWW, conflict detection)
- Accountant role
- Multi-device conflict resolution UI

---

## Marketing Roadmap (ChatGPT-led)

| Status | Item |
|---|---|
| 📋 | Marketing website (`qstore.seanscales.com.au` or similar) |
| 📋 | Pricing page — V2 Annual vs V3 IMS-Only vs V3 IMS+Accounting |
| 📋 | Feature comparison table (V2 vs V3) |
| 📋 | AAC-specific landing page copy |
| 📋 | Email sequence for trial expiry |
| 📋 | Renewal reminder at 30/14/7 days before expiry |
