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
| loan `remarks` | ~~DONE~~ — curated vocabulary (4 surfaces) |
| loan `lineNotes` | ~~DONE~~ — removed entirely |
| activity / location name | ~~DONE~~ — managed list (step 2) |
| stocktake `countedBy` | PENDING — operator's name, an adult |
| request `notes` | ~~DONE~~ — module removed (step 5) |
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

## Removal is not disposal

Step 3 removed the cadets *module*. It did not delete anyone's data, and the
distinction is deliberate.

- A **fresh install** has no cadet rows. It carries no PII. Condition met.
- An **upgraded install** still has its cadet rows. They are not ours to destroy:
  extraction to CEA comes first, and disposal needs HQ's direction (§13.1).

So `Storage.cadets.list()/get()` remain — the data must stay reachable for that
extraction — while `put()` refuses, so nothing new is collected. `exportAll()`
still includes the store, on purpose: dropping it would mean a backup-and-restore
cycle silently destroyed the very records we are required to extract first.
**Destruction by omission is still destruction.**

This is precisely why the direction at §13.1 is being sought, and why the
controls statement must not claim an upgraded unit carries no PII until its
legacy rows are gone.

## Findings from step 8

**Four remark surfaces, not one.** The issue form, the return form, the
bulk-return modal and the quick-return modal each had their own free-text box.
Converting the two obvious forms and stopping would have left two modals — the
ones a QM actually uses on a busy night — still collecting sentences. Grep for
the *field*, not the form.

**Constrained, not deleted.** "Returned unserviceable — damaged" is worth
recording; the sentence around it is the problem. A `<select>` over a curated
list cannot hold a sentence and therefore cannot hold a name. Observations that
don't fit the list belong in the item's maintenance log, which is retained
because it is about the item.

**`countedBy` is NOT free text a cadet lands in** — `stocktake.js` sets it from
`AUTH.getSession()?.name`, i.e. the operator. An adult. Same unanswered question
as staff, users and the orders requestor. Left alone deliberately.

**`lineNotes` — REMOVED** (follow-up to step 8). A free-text box against every
issued item line. Smaller surface than `remarks`, same surface: a box next to an
issued item collects "Smith's, size 10". A fixed vocabulary fits per-line notes
badly, so it was deleted rather than constrained; equipment observations belong
in the item's maintenance log, which is retained because it is about the item.

New loans carry no `notes`. Legacy rows may, and they stay VISIBLE — labelled
"Notes (legacy)" — until extraction and disposal. Hiding them would hide exactly
what needs extracting.

Removing it also surfaced a stale comment claiming to "intentionally preserve
lineNotes across the toggle", describing a field that no longer existed. That is
the same defect class as the piiKey docstring: prose asserting behaviour the code
does not have.

**Still free text, still pending the adults question:** `orders.js` "QM Notes",
and `stocktakeCounts.countedBy`.

## Findings from step 7

**The login screen was reading the cadet register before anyone authenticated.**
The cadet picker called `Storage.cadets.list()` to render "SURNAME F." on the
sign-in card — cadet PII displayed pre-auth, to whoever had the file open. Gone
with the picker.

**A cadet user account is cadet PII by another route.** `PII_FIELDS_USERS` is
`['name','svcNo','totpSecret']`, so an account with role 'cadet' carries a
cadet's name and service number in the users store — independently of the cadets
store we emptied. Removing the role does not remove those rows.

They are **hidden and refused, not deleted**: `login()` rejects role 'cadet'
before verifying the PIN (no point spending an argon2id verification on an
account that cannot proceed, and no reason to tell it whether its PIN was
right), and the picker no longer lists them. Deleting them is disposal, which is
gated on §13.1 like every other legacy record.

`isCadet()` is retained deliberately though the role is gone — an upgraded
database still holds these accounts, and the existing guards in staff.js,
shell.js and loans.js should keep locking them out rather than silently
evaluating false and granting access. Belt to login()'s brace.

## Findings from step 6

**v1 loans cannot be converted, only skipped.** Every v1 loan carries
`borrowerName`/`borrowerSvc` — it records who holds an item. The identifier-free
model needs an issue-document number to stand in for the person, and a v1 loan
has none to map onto. Inventing one would invent a link to a document that does
not exist. So v1 person data is not imported at all; it stays in the v1 file and
belongs in CEA.

**The skip must be loud.** A migration that silently drops a unit's entire loan
history and reports success is worse than one that fails: the operator assumes
the import was complete and never extracts the data. The import now writes an
audit entry naming what was skipped and directing extraction to CEA, and
`test-v1-import` asserts that entry exists — that assertion is the point of the
test now.

**I broke this file twice with regex surgery** before doing it by line number
with a pre-flight guard that refuses to cut a block containing an items-path
*definition*. The first attempt deleted every shared helper (`_parseCsv`,
`_mapHeaders`, `_validateItemRow`) because `commitCadets` was the last export and
"cut to the next export" ran to EOF. The second ate `parseItemsCsv` because a
non-greedy regex started at the wrong `/**`. Both were caught by running the
test, not by reading the diff.

## Findings from step 5

**Two stores declare PII encryption they never apply.** `pii.js` defines
`PII_FIELDS_REQUESTS` and `PII_FIELDS_ORDERS`, but `storage.js` applies neither —
so `requestorName`, `requestorRank`, `requestorSvc`/`requestorSvcNo` and
`countedBy` are held in **plain text**. A declared field list that nothing reads
is worse than none: it reads, to anyone auditing pii.js, as though those stores
are protected. This is the defect disclosed at controls statement §8.3, and it is
the `PromptBuilder()`/`repair_rules` shape again — a declaration with no caller.

Removing the requests module removes half of it. The other half is orders.

**`supplyOrders` still carries a plaintext requestor** (`ui/orders.js`,
`order-parser.js` — 25 references). Deliberately NOT actioned: a supply-order
requestor is a QM raising an order to higher, i.e. an adult, which puts it in the
same unanswered question as staff and users (see "Open question" above). Guessing
it either way in code is exactly what this note exists to prevent.

**If HQ reads "no PII" strictly**, this is the work: orders' requestor fields,
`stocktakeCounts.countedBy`, the `staff` store, and user account names. None of it
is cadet data; all of it is PII.

## Findings from step 3

**Tests that seeded cadets now fail correctly, and were re-pointed rather than
deleted.** `test-key-rotation` seeded cadets to have PII to rotate; it now seeds
**staff**. That is a better test than it was: staff and users are adults, they
survive this rebuild, and rotation matters exactly as much for their data.

**`test-cadets.mjs` is a latent trap.** It tests cadet CRUD that no longer
exists, and is currently *masked* by the pre-existing `localStorage`
ReferenceError — so whoever fixes that failure will hit a confusing "does not
store cadet records" error instead. It should be deleted or rewritten to assert
the refusal. **Not done — flagged rather than silently left.**

**My dangling-call checker gives false positives** on object methods and named
function expressions (`_legacyPutDisabled`, `_cloudSectionHtmlImpl`). It caught
the real loans.js breakage, but do not trust its clean runs as proof.

## Findings from step 2

**The v1 import reintroduces PII, and the fail-closed guard caught it.**
`test-v1-import.mjs` now fails with:

> `Loan carries a person identifier (borrowerName/borrowerSvc). This build
> records location + issueNo only.`

That is the guard working. `migration.js` imports v1 loans complete with
`borrowerName`/`borrowerSvc`, so a unit upgrading from v1 would have silently
repopulated the database with cadet identifiers — into a build whose entire
authority rests on not carrying them. Had `loans.put()` merely encrypted what it
was given, nothing would have failed and nobody would have looked. **The v1
import path must be removed or rewritten** (build order step 6a below).

**`listForCadet` callers outside loans.js.** All five are in `ui/cadets.js`,
which step 3 removes. No action needed beyond doing step 3.

**Modules still carrying borrower fields** — all are later steps, none block
loans.js: `pdf.js` (17), `requests.js` (20), `ims-reports.js` (8),
`dashboard.js` (1), `inventory.js` (1).

## Known and deliberately not fixed

### Cadet names in the audit chain — surfaced, not fixable here

Every audit entry records `user: <name>`. So **any cadet who ever signed in to an
earlier build has their name in the audit log**, and removing their cadet record,
their loans' borrower fields, and their login account does not touch it.

It cannot be scrubbed from here, and it should not be:

- The chain is `HMAC(auditKey, [prevHash, ts, action, user, desc])`. Altering any
  entry breaks verification for that entry and every one after it. A scrubbed
  chain is indistinguishable from a forged one — the same reason re-signing after
  key rotation restores nothing (see the controls statement §9).
- The audit log **is** the Commonwealth record of what happened. Editing it to
  look compliant is the offence the Archives Act describes, not a remedy for it.

So the position is: the identifier-free build collects no new names into the
audit log — there is no cadet role, no cadet can sign in, and no cadet action can
be recorded. Historic entries from an earlier build retain the names of cadets
who used it, permanently, by design.

**This needs to be told to HQ rather than solved in code.** It belongs in the
controls statement §4 and in the disposal question at §13.1: after extraction and
purge, an upgraded database carries no cadet PII *except* the names in its own
audit history. That is a smaller and more defensible surface than the one we
started with, but it is not zero, and claiming zero would be false.



Recorded here rather than left to be rediscovered. None of these block the two
units; all of them would bite somebody eventually.

### V3 backups are refused, with misleading advice

V2's `DB_VERSION` is 4; V3's is 7. `importAll()` refuses any snapshot with a
higher `schemaVersion` and says:

> *"Backup is from a newer version of QStore (v7). Update the app before
> restoring."*

That advice made sense when V3 was the upgrade path. For a Defence build it is a
dead end — the Defence build **is** the destination, there is nothing to update
to, and an operator would go looking for one. The message should say what is
true: this build cannot read a V3 backup, and V3 data has to come across by
another route.

**Not urgent:** no unit runs V3 (author's testing instance only, confirmed
2026-07-17). If that ever changes it becomes a blocker, not a nit — a V3 unit
could not move to the Defence build at all.

### Unknown stores are dropped silently on import

Generic, not V3-specific. `importAll()` writes only the 14 stores it knows.
Anything else in a snapshot vanishes without a word.

If a V3 backup ever *did* get through the version gate, the silent casualties
would include **`expenseClaims`, which carry `claimantName`** — person data —
plus `supplierBook`, `bankTx`, purchase orders, the chart of accounts and
transactions. The unit would restore, see inventory and loans arrive, reasonably
conclude it worked, and never learn their accounting records were gone.

Same failure as the v1 import before it was fixed: **a restore that looks like it
worked**. Import should report what it did not recognise.

### `test-cadets.mjs` tests CRUD that no longer exists

Masked by the pre-existing `localStorage` failure, so it looks like one of the
six. Whoever fixes that failure will hit a confusing "does not store cadet
records" error instead. Delete it or rewrite it to assert the refusal.

### Adults: `staff`, users, orders requestor, `countedBy`

The open question at the top of this note. All are PII; none are cadet data.
HQ's objection was the cadet aggregate. Unanswered, so unguessed — see
controls statement §13.3.

### `orders.js` "QM Notes" is still free text

Same reasoning: it collects an adult's words, and the adults question is open.

---

## Build order

1. ~~**Schema + storage**~~ — DONE. Loans lose `borrowerName`/`borrowerSvc`,
   gain `location` + `issueNo`. Index on `issueNo`. `put()` fails closed.
2. ~~**Loans UI**~~ — DONE. Destination select replaces the borrower picker;
   returns and the all-loans view group by issue/destination; AB189 and voucher
   print with recipient fields blank; the discharged flag and phantom-borrower
   cleanup are gone (both required a person record to compare against).
3. ~~**Cadets module**~~ — DONE. Page and `ui/cadets.js` deleted; demo seed no
   longer creates cadets; `Storage.cadets.put()` refuses all writes. The STORE
   and its rows remain — see "Removal is not disposal" below.
4. ~~**PDFs**~~ — DONE. `generateNominalRoll` and `generateCadetKitChecklist`
   deleted (no callers once the Cadets page went). Voucher/AB189 batch on
   issue+date instead of borrower+date, print recipient blocks BLANK with ruled
   lines for hand completion, and carry the issue number. Filenames now use the
   issue reference — a service number no longer appears in a filename, which
   matters: filenames leak into file managers, mail attachments and screen
   shares long before anyone opens the document.
5. ~~**Requests**~~ — DONE. `ui/requests.js` (1936 lines) and
   `generateRequestAB189` deleted; `Storage.requests.put()` refuses; the blank
   AB189 print moved to the Loans page, since deleting the module would
   otherwise have taken the replacement workflow with it.
6. ~~**CSV import**~~ — DONE. Cadet CSV import removed (parse, commit, aliases,
   validator, personType inference). The items importer is untouched.
6a. ~~**v1 import**~~ — DONE. Imports equipment; cadets, loans and requests are
    NOT imported and the skip is written to the audit log with a direction to
    extract them to CEA.
7. ~~**Login**~~ — DONE. `cadet` removed from ROLES/PERMS; login() refuses
   role 'cadet' before verifying the PIN; the cadet picker and its cadet-register
   read are gone. Legacy cadet accounts are hidden AND refused, not deleted.
8. ~~**Free text**~~ — DONE for loans. All four remark surfaces (issue form,
   return form, bulk-return modal, quick-return modal) are now selects over a
   curated vocabulary in `locations.js`. `stocktakeCounts.countedBy` is NOT
   done — it holds an operator's name, i.e. an adult, pending HQ's answer.
9. **Migration** — gated on §13.1.

Each step is a separate commit. Nothing merges to `main` until the whole is
coherent: a half-removed cadets module is worse than either end state.
