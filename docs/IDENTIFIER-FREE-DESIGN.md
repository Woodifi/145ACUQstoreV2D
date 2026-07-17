# Identifier-free build — design note

**Status:** in progress
**Authority:** CPL James Jenkins, Acting Systems Administrator, HQ AAC — email
17 July 2026. See `DEFENCE-CONTROLS-STATEMENT.md` §2 and §5.

---

## The constraint, in one line

> *"So long as you're not carrying PII and it's purely for asset tracking, I'd
> see no issue."* — HQ AAC ICT, 17 July 2026

Everything below follows from that sentence. It is a **condition**, not a
preference: if the tool carries PII, the basis for HQ's position is gone. That
makes some things that would normally be product decisions — free-text fields,
for instance — non-negotiable.

## What the tool becomes

An **equipment** tool. Stock, condition, stocktake, write-off, orders. It records
what the unit holds and what state it is in.

It does **not** record who has anything. Where an item is issued to a person, the
tool records only:

- `location: individual` — that the item is out to a person, not which person
- `issueNo` — a reference to the document that says which person

The document (AB189, Issue Voucher, kit checklist) is printed with identifier
fields **blank**, completed by hand, and uploaded to that individual's CEA
documents. **CEA holds the person↔equipment link. The tool never does.**

## The records boundary

> *"The point at which it becomes a record is when it needs to end up in CEA or
> CadetNet. For example, you complete a stock take, that completed stock take
> report must be stored in CadetNet as it's a record."* — HQ, 17 July 2026

The tool's working data is **not** a Commonwealth record. The artefact it
produces — the completed stock take report, the Q record — is, and it lives in
CEA. This is why the tool needs no retention schedule: it isn't holding the
record. See controls statement §8.5.

## Open question — does "no PII" include adults?

**Unresolved. Do not guess in code.**

The tool holds PII about adults as well as cadets:

| Store | Fields | Whose |
|---|---|---|
| `staff` | surname, given, email, notes | adult staff |
| `users` | name, svcNo, totpSecret | adult operators |
| `audit` | `user` — who performed each action | adult operators |

Read strictly, "not carrying PII" removes all of these. But then nobody can log
in, and the audit chain attributes actions to nobody — which destroys the control
it exists to provide.

HQ's objection was specific: *"the Cadet ID, First and Last Name of **all the
cadets in your unit** … in aggregate."* A handful of adult operators running a
tool is not that aggregate. The reasonable reading is **cadets only**.

That reading has not been confirmed. Controls statement §13.3 asks HQ to examine
the built tool against the condition rather than relying on self-assessment. Until
that is answered:

- **Cadet identifiers: removed.** Required under either reading — no rework.
- **Staff and user accounts: unchanged, pending HQ's answer.**

If HQ reads the condition strictly, users become opaque handles and the `staff`
store goes. That is a further change, not a redesign of what is below.

## Free text is a compliance surface, not a UX choice

The predictable failure: a user types `"Smith's section"` into an activity name,
or `"issued to CDT Jones"` into remarks. The tool is then carrying PII, in an
unencrypted field, and HQ's condition is breached — silently, with no schema to
point at and no test to catch it.

So person-adjacent free text is **removed**, not discouraged:

| Field | Disposition |
|---|---|
| loan `remarks` | Constrained vocabulary or removed |
| loan `lineNotes` | Constrained vocabulary or removed |
| activity / location name | Managed list, not free text |
| stocktake `countedBy` | Removed (or operator handle if adults are permitted) |
| request `notes` | Removed |
| item `notes` / maintenance log | **Retained** — about equipment, not people |

A user determined to write a name somewhere will always find a way. The goal is
that they cannot do it *by accident*, and that no field invites it.

## What is lost, and must not be discovered by a QM on a parade night

- **Overdue tracking by person.** The tool can say an item is out and overdue; it
  cannot say who has it. Chasing it becomes a documents task in CEA.
- **Discharge recall.** No cadet records, so no automatic recall of a departing
  member's kit.
- **Per-person kit checklists.** Printed blank, completed by hand.
- **Nominal roll.** Removed entirely — it is, by definition, a list of cadets.
- **Double handling.** Every issue is recorded once here and once in CEA.

These are real regressions. They are the price of the condition, and they should
be stated to units before rollout rather than discovered.

## Migration

Existing databases hold cadet records and loans carrying `borrowerName` /
`borrowerSvc`. On upgrade the tool must:

1. Strip cadet identifiers from loan records, retaining the loan itself
   (`ref`, `itemId`, `qty`, dates, condition) and marking it `location:
   individual` with an `issueNo`.
2. Drop the `cadets` store.
3. Leave an audit entry recording that identifiers were removed.

**Do not implement destructive migration until HQ confirms the disposal process**
(controls statement §13.1). Extracting the existing data to CEA documents is a
prerequisite to deleting it, and issue/loan history may be a record. Destroying a
Commonwealth record on our own initiative is not a decision this codebase gets to
make — see DYM S1 Ch2 para 67 and the *Archives Act 1983*.

## Build order

1. **Schema + storage** — loans lose `borrowerName`/`borrowerSvc`, gain
   `location` + `issueNo`. Index on `issueNo`.
2. **Loans UI** — borrower picker → location/activity picker + issue number.
3. **Cadets module** — removed.
4. **PDFs** — nominal roll removed; AB189 / voucher / checklist print with blank
   identifier fields and the issue number.
5. **Requests** — requestor fields removed.
6. **CSV import** — cadet import removed.
7. **Login** — cadet role removed.
8. **Free text** — per the table above.
9. **Migration** — gated on §13.1.

Each step is a separate commit. Nothing merges to `main` until the whole is
coherent: a half-removed cadets module is worse than either end state.
