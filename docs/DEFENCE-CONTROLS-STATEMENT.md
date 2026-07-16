# QStore IMS — Security, Privacy and Youth Protection Controls Statement

**Status:** DRAFT for internal review — not yet submitted
**Applies to:** QStore IMS v2.3.0, Defence build (`build.js --defence`)
**Prepared:** [DATE]
**Prepared by:** [NAME, APPOINTMENT, UNIT]
**Classification:** [TO BE DETERMINED BY DEFENCE — see §10]

---

## 1. Purpose of this document

This statement describes a unit-level Q-Store inventory system, the personal
information it holds, the controls applied to that information, and — with equal
prominence — the limitations and residual risks that remain.

It is **not** a claim of compliance. Compliance is a determination for Defence to
make, not for a developer to assert. This document is intended to give whoever
makes that determination an accurate basis on which to make it, including the
matters that count against the system.

**What is sought:** guidance on the appropriate pathway for a unit-level Q-Store
capability, and a decision on whether continued use under the controls described
here is acceptable in the interim.

---

## 2. What QStore is, and what it is not

QStore IMS is a single-file HTML/JavaScript application for tracking Q-Store
equipment at unit level: inventory holdings, issues and returns, stocktakes,
condition and write-off records, and the associated printed forms (Issue Voucher,
AB189, AB174 Board of Survey, kit checklists, nominal roll).

**It is not** a personnel management system. It is not proposed as a system of
record for cadet personal information. It holds identifying data only to the
extent required to record who holds which item of Commonwealth equipment and to
produce the forms that must accompany that.

**Current deployment:** [N] units, trial use. [STATE DATES.]

---

## 3. The capability gap

[**THIS SECTION REQUIRES DOCUMENTARY SUPPORT AND MUST NOT BE ASSERTED WITHOUT IT.**]

Defence Youth Manual, Part 2, Section 4, Chapter 4 (*ADF Cadets Information and
Communication Technology*) para 4.4.2 describes CadetNet as an approved system
providing the capacity to electronically manage personnel, logistics, facilities,
training and cadet activities.

It is understood that CadetNet does not currently provide unit-level Q-Store
equipment tracking, and that this is an acknowledged deficiency.

> **[TO BE COMPLETED]** Cite the written record of that acknowledgement — minute,
> briefing paper, change request, working group record, or correspondence, with
> date and originator. If no written record exists, this section must be reframed
> as an assertion requiring verification by Defence, and the document's request
> changes accordingly. **Do not submit this section on the strength of a verbal
> acknowledgement presented as an established fact.**

In the absence of an approved system providing this function, units record
Q-Store holdings by other local means. The relevant comparison for risk purposes
is therefore between this system and the arrangements actually in use, rather
than against a hypothetical approved alternative.

---

## 4. Personal information held

| Data | Held | Encrypted at rest |
|---|---|---|
| Cadet surname, given name | Yes | Yes — AES-256-GCM, per field |
| Cadet email address | Yes | Yes |
| Cadet free-text notes | Yes | Yes |
| Service number | Yes | No — used as the record key |
| Rank, company/platoon/section | Yes | No |
| Loan records (borrower name, remarks) | Yes | Yes |
| Staff surname, given name, email, notes | Yes | Yes |
| User account name, service number, TOTP secret | Yes | Yes |
| Equipment request requestor name, rank, service number | Yes | **No — see §7.3** |
| Stocktake "counted by" name | Yes | **No — see §7.3** |

**The information relates predominantly to minors.** Australian Army Cadets are
generally aged 12½–20.

**This data is not de-identified.** A service number is a unique identifier that
resolves to an individual through the system of record. Information keyed to it
remains personal information under the *Privacy Act 1988* (Cth), and the
obligations in that Act apply in full.

---

## 5. Controls

> **Basis of these statements.** Every control below was verified by reading the
> implementation on 17 July 2026, not by relying on prior documentation. This
> distinction is not pedantry: the defect at §9 existed precisely because a
> documented description of the code was trusted and the code was not re-read.
> During preparation of this document, one further instance was found — an
> internal comment describing the account lockout policy stated durations 30
> times shorter than those the code actually applies. The code was correct and
> the comment was stale. It has been corrected. **No control is asserted here on
> the strength of documentation alone.**

### 5.1 No cloud egress (Defence build)

The Defence build has **no capability to transmit data to third-party cloud
storage**. This is not a configuration setting that has been switched off — the
cloud synchronisation code, the Microsoft Authentication Library, and the
Microsoft Graph endpoints are **not present in the artefact**. They are removed
at build time.

This is stated as a verifiable property rather than an assurance: the delivered
file can be searched for `graph.microsoft.com`, `msal`, and OneDrive API paths,
and contains none of them. An automated test (`test-defence-build.mjs`) enforces
this on every build and will fail if any cloud code re-enters the artefact. The
test first confirms the *standard* build does contain those strings, so that the
absence in the Defence build is a meaningful result rather than a vacuous one.

Data resides in browser-local storage (IndexedDB) on the unit device. It leaves
only via an operator-initiated encrypted export (§5.5).

Relevant requirement: Defence Youth Manual Pt 2 S4 Ch4 para 4.4.5(c) — ADF Cadets
ICT systems are to be hosted in Defence-approved data centres or ASD-approved
cloud providers. The Defence build has no hosting component and no cloud
transmission path.

### 5.2 Encryption of personal information at rest

Personal information fields are individually encrypted with **AES-256-GCM** using
a key generated on, and held on, the device.

AES is the only approved symmetric algorithm under the ASD *Information Security
Manual* — *Guidelines for cryptography*, and **ISM-1769** provides that where AES
is used, AES-256 is preferred. The implementation uses AES-256. GCM is an
authenticated mode; **ISM-0479** prohibits ECB, which is not used anywhere.

### 5.3 Access control and authentication

- Per-user PINs hashed with **argon2id**.
- **TOTP two-factor authentication** (RFC 6238), with SHA-256-hashed single-use
  backup codes and a replay guard.
- Role-based access: Commanding Officer, Quartermaster, Staff, Cadet, Read-Only.
- **Cadet isolation:** accounts with the cadet role can view only their own
  records; the staff register is inaccessible to them; the login picker discloses
  surname and first initial only.
- Escalating lockout on failed PIN attempts: 5 consecutive failures → 15 minutes;
  10 → 30 minutes; 15 or more → 60 minutes. Lockout state survives a page
  refresh.
- Idle auto-lock. Default 15 minutes; the minimum selectable value is 5 minutes
  and there is no "disabled" option — a stored value of zero is rejected and the
  default applied. The lock screen requires the PIN, and where two-factor
  authentication is enabled it requires the second factor as well; the session
  token is removed from browser storage while locked, so closing the browser
  while locked does not restore an authenticated session.

### 5.4 Audit

Every action is recorded in an append-only audit log. Entries are chained with
**HMAC-SHA256**, each entry's signature incorporating the previous entry's hash,
so that retrospective alteration or deletion is detectable. Read access to cadet
and staff records is itself audited.

The integrity guarantee this provides is qualified — see §7.1 and §9.

### 5.5 Backups

Export produces an **encrypted file only**. There is no unencrypted export
option. Key derivation is PBKDF2-HMAC-SHA256 at 310,000 iterations, with a random
32-byte salt per export, encrypting under AES-256-GCM.

> **Attribution note.** The 310,000-iteration figure follows **OWASP** guidance.
> It is **not** an ASD or ISM requirement: PBKDF2 is not addressed in the ISM's
> *Guidelines for cryptography* and is not an ASD-Approved Cryptographic
> Algorithm. The same is true of argon2id (§5.3). These are considered
> appropriate engineering choices; they are **not** presented as ASD-approved,
> and any assessment should treat them as requiring separate judgement.

### 5.6 Key management

An operator-initiated key rotation re-encrypts all personal information under a
newly generated key and re-signs the audit chain. See §9 for the circumstances in
which this was introduced and what it does and does not achieve.

---

## 6. Privacy obligations

| Obligation | Status |
|---|---|
| APP 1 — open and transparent management | Partial — no published privacy policy for this system |
| APP 3 — collection of solicited personal information | Collection limited to equipment-accountability purpose |
| APP 5 — notification of collection | **Not implemented — see §7.5** |
| APP 6 — use or disclosure | Data does not leave the unit device (Defence build) |
| APP 8 — cross-border disclosure | Not applicable — Defence build has no transmission path |
| APP 11 — security of personal information | Controls at §5.2–§5.5 |
| APP 12 / 13 — access and correction | Records are directly viewable and editable by unit staff |

Defence Youth Manual Section 1, Chapter 2 (*Youth Protection Privacy,
Documentation, and Record Management*) para 50 records the obligation under the
*Privacy Act 1988* and **Article 16 of the UN Convention on the Rights of the
Child**.

---

## 7. Known limitations and residual risk

This section is deliberately as detailed as the controls section.

### 7.1 The system holds no accreditation

Defence Youth Manual Pt 2 S4 Ch4 para 4.4.6 anticipates that ADF Cadets ICT
systems maintain a current **Defence Digital Group security accreditation**
against the ISM. **This system holds no such accreditation**, has not undergone an
**IRAP assessment**, and has not been penetration tested by an independent party.
No claim of accreditation is made or implied.

### 7.2 The endpoint is not a Defence-controlled environment

Data resides on a unit-owned device. Removing cloud transmission narrows exposure
from a third-party tenant to that endpoint; it does not place the data inside a
Defence-controlled system. If the concern is that cadet information persists
outside Defence-controlled systems, **the Defence build reduces that exposure but
does not eliminate it.**

### 7.3 Some personal information is not encrypted at rest

Equipment-request requestor name, rank and service number, and the stocktake
"counted by" name, are **stored in plain text**. The encryption module defines
these fields but the storage layer does not apply it to them. This is a defect,
it is not yet fixed, and it is disclosed here rather than discovered later.

### 7.4 Device-level compromise is out of scope

Encryption at rest protects data if the storage is copied off the device. It does
not protect against an attacker with live access to an unlocked, running session
on the device itself. This is a documented and accepted limitation.

### 7.5 Mandatory privacy statement not present

Defence Youth Manual Section 1, Chapter 2, para 55 requires that a specified
privacy statement be used on all documentation and **information technology
systems** where Defence collects information relating to youth. **This system does
not currently carry that statement.** This is a straightforward non-compliance and
is being remediated.

### 7.6 Records management is not implemented

Loan and issue history constitutes Commonwealth records. Defence Youth Manual
Section 1, Chapter 2, para 67 records that ADF Cadets members must comply with
records management obligations, with criminal penalties under the *Archives Act
1983* for unlawful destruction. **NAA Records Authority 2019/00457762** (Defence
Youth and Cadets) governs retention and disposal of cadet records.

The system implements **no retention schedule and no controlled disposal**.
Records can be deleted by unit staff at will, and a device failure destroys them.
Removing cloud synchronisation removes what was, in practice, the off-device
copy — so this risk is **increased**, not reduced, by §5.1, unless disciplined
encrypted backups are maintained.

### 7.7 No Privacy Impact Assessment

A system holding personal information about minors is likely a high privacy risk
project, for which a **Privacy Impact Assessment** is required of Commonwealth
agencies. **No PIA has been conducted.**

### 7.8 Support model and key person risk

The system is maintained by a single developer. There is no support agreement, no
service level, no independent vulnerability management, and no source code
escrow. **The key person risk is total.**

### 7.9 Commercial interest — declaration

The author maintains QStore as a commercially licensed product outside ADF Cadets
and is associated with the Australian Army Cadets. That is a conflict of interest
and is declared here rather than left to be discovered.

**No payment is sought from the Commonwealth for the Defence build.** It is
offered free of charge for ADF Cadets youth programmes; no licence fee,
subscription, or per-unit charge is sought now or in future. The proposed terms
are at §8. Nothing in this document is a request for procurement.

The residual interest, stated plainly so that it can be weighed rather than
inferred: the author retains a commercial product line outside ADF Cadets youth
programmes (§8.5), and adoption of the Defence build would raise the profile of
that product line. That is a real interest, and it is the reason this declaration
exists.

> **[TO BE COMPLETED — DO NOT OMIT.]** The author must complete this in their own
> terms, covering: their appointment and relationship to the Australian Army
> Cadets; the nature and scale of the commercial product line; and the ownership
> position at §8.7 — specifically whether any part of QStore was developed while
> performing cadet duties, on Defence equipment, or using Defence information.
> **Declared at the outset this is manageable; discovered later it is fatal to
> the proposal, however sound the software.**

---

## 8. Licensing and intellectual property

> **Statement of intent, not licence terms.** This section records what is
> intended. It has not been settled by a lawyer and is **not** an offer capable
> of acceptance. Binding terms must be drafted and reviewed before any grant is
> made — a licence to the Commonwealth, from an author with the interest declared
> at §7.9, touching information about minors, is not a document to settle
> informally.

### 8.1 Intent

The Defence build is offered to the Commonwealth **free of charge** for use in
ADF Cadets youth programmes. No licence fee, subscription, or per-unit charge is
sought, now or later, for that use.

### 8.2 Proposed grant

A royalty-free, non-exclusive, perpetual licence to the Commonwealth to use,
install, and modify the Defence build **for the purposes of ADF Cadets youth
programmes**.

### 8.3 Expressly permitted — including paid work

The following are intended to be permitted, and the licence should say so
explicitly:

- Use across any number of ADF Cadets units.
- Modification by or for the Commonwealth for its own use.
- **Engagement of third parties, for payment, to provide services to the
  Commonwealth in respect of this software** — including hosting, security
  assessment and accreditation, integration, maintenance, and user support.

The third point is deliberate and load-bearing. Any pathway to accreditation runs
through paid contractors — an IRAP assessor, a hosting provider, a support
function. A licence that could be read as prohibiting payment to those parties
would make the software unadoptable, which serves nobody. **Being paid to
accredit, host, or support this software for the Commonwealth is not the thing
this licence restricts.**

### 8.4 Not permitted

- Sale, resale, or sublicensing of the software.
- Redistribution outside ADF Cadets youth programmes.
- Incorporation into a product or service offered for sale to any party.
- Rebadging or distribution as a third party's own product.

### 8.5 Reserved rights

All rights not expressly granted are reserved by the author, including the
right to license QStore commercially outside ADF Cadets youth programmes. The
Defence build is a distinct, functionally narrower variant: cloud synchronisation
is removed at build time and it contains no accounting module. It is not the
commercial product.

### 8.6 Source access and continuity

Two matters that Defence will raise, addressed here rather than left implicit:

- **Source access for assessment.** Security accreditation requires code review.
  Source will be made available for assessment purposes. The terms on which it is
  provided, and whether it extends beyond assessment, require decision.
- **Continuity.** The software is maintained by one person (§7.8). Defence should
  not adopt a capability that dies with its author's availability. Source code
  escrow, or a fallback grant taking effect if maintenance ceases, should form
  part of any agreement. **[TO BE DECIDED.]**

### 8.7 Ownership

> **[TO BE COMPLETED — settle before any offer is made.]** The author can only
> license what the author owns. State the position on whether any part of QStore
> was developed while performing Australian Army Cadets duties, using Defence
> equipment, facilities, or information, or otherwise in circumstances that may
> vest or encumber rights in the Commonwealth. **If ownership is not clear, the
> grant at §8.2 is not the author's to make, and this must be resolved first
> rather than discovered during assessment.**

---

## 9. Disclosure — security defect identified and remediated

This is disclosed voluntarily and in full.

### What the defect was

The application's database snapshot included an internal metadata store. That
store held two secrets: the AES-256-GCM key protecting all personal information,
and the HMAC key underwriting the audit chain. The synchronisation routine wrote
that snapshot to cloud storage as plain JSON, and the file export offered an
unencrypted option that wrote the same content to disk.

**The consequence:** any such file contained both the encrypted personal
information and the key required to decrypt it. **The encryption control was void
for any data that left the device.** The audit key's exposure additionally means
audit entries written before remediation could be forged by anyone holding such a
file.

### How it arose

The routine that restores a snapshot carried a documented justification for
including the metadata store — preserving audit chain verifiability across
devices. That justification is sound, and it referred only to the audit key and
installation identifier. It predates the introduction of personal-information
encryption. When the encryption key was later added to the same store, it
inherited that export path silently, carrying a confident and well-argued
rationale that had nothing to do with personal information. Subsequent reviews
saw a considered decision and did not revisit it.

No test asserted that key material was absent from exported data. The defect was
found by reading the code, not by a failure.

### Remediation

| Action | Status |
|---|---|
| Cloud transmission removed entirely from the Defence build | Complete |
| Export encryption made mandatory; unencrypted option removed | Complete |
| Key rotation implemented (new encryption key, all data re-encrypted) | Complete |
| Cloud file deleted from affected storage, including version history | [TO BE CONFIRMED] |
| Trial units notified and use suspended pending remediation | [TO BE CONFIRMED] |
| Automated tests asserting key material is absent from exported data | Complete |

### What rotation does not fix — stated plainly

**Rotating the encryption key restores confidentiality going forward.** Data is
re-encrypted under a new key; the exposed key no longer opens it.

**Rotating the audit key does not restore the integrity guarantee for entries
written before rotation.** The audit chain is an HMAC construction: once the key
was exposed, every pre-rotation entry became forgeable, and no subsequent action
can undo that. Re-signing the chain under a new key makes verification pass, but
re-signing is exactly what a forger would do — it does not make those entries
trustworthy. **Only audit entries created after the rotation marker carry a
meaningful integrity guarantee.** The system records this boundary permanently in
the audit log in these terms.

### Assessment of exposure

> **[TO BE COMPLETED — this determines the reportability of the incident.]**
>
> Establish and record: whether the affected cloud file or folder was ever shared
> with any party; whether any access by an unauthorised person occurred; the
> accounts with access; and whether multi-factor authentication was enabled.
>
> Under **Part IIIC of the *Privacy Act 1988*** an eligible data breach requires
> unauthorised access, unauthorised disclosure, or loss, together with a
> likelihood of serious harm (**s 26WE**, **s 26WG**). If the file was never
> accessible to anyone outside the unit, there may be no eligible data breach.
> **This is a question of fact and must be answered on evidence, not assumed in
> either direction.** Where there are reasonable grounds to suspect an eligible
> data breach, **s 26WH** requires assessment to be completed within **30 days**.
> Sensitivity is heightened because the affected individuals are minors.

---

## 10. Classification

No classification is asserted in this document.

Under the **Protective Security Policy Framework (Release 2026)**, the originator
assesses the potential damage from compromise (**Requirement 0059**) and sets the
classification at the **lowest reasonable level** (**Requirement 0060**).

It is noted that the PSPF statement sometimes quoted as "personal information will
always be classified at least OFFICIAL: Sensitive" appears within the
security-clearance vetting context and is scoped to that context. It is **not**
relied on here as a general rule, and should not be so relied on by any reader of
this document.

The classification of a unit Q-Store holding equipment-accountability data about
minors is a matter for Defence to determine.

---

## 11. References

All references were verified against publicly available primary sources on
**17 July 2026**. Instruments that are Defence-intranet-only, and could not be
verified, are **not** cited.

**Legislation**
- *Privacy Act 1988* (Cth), Schedule 1 — Australian Privacy Principles.
  https://www.oaic.gov.au/privacy/australian-privacy-principles/read-the-australian-privacy-principles
- *Privacy Act 1988* (Cth), **Part IIIC** — Notifiable Data Breaches scheme.
  https://www.oaic.gov.au/privacy/notifiable-data-breaches/about-the-notifiable-data-breaches-scheme
- *Defence Act 1903* (Cth), **Part V — Australian Defence Force Cadets**, ss 62–62E.
  Compilation C2026C00299, compilation date 1 July 2026.
  https://www.legislation.gov.au/C1903A00020/latest/text
- *Defence Regulation 2016*, **Part 15A — Australian Defence Force Cadets**.
  (The *Cadet Forces Regulation 2013* is **repealed** and is not the operative
  instrument, notwithstanding its continued citation in secondary sources.)
- *Archives Act 1983* (Cth).

**Defence**
- *Defence Youth Manual*, Edition 1. Head Reserve and Cadet Support, 11 July 2025.
  Marked OFFICIAL. — Section 1, Chapter 2 (*Youth Protection Privacy,
  Documentation, and Record Management*), paras 50, 55, 62, 67.
  https://www.defenceyouth.gov.au/media/iobfus5d/defence-youth-manual.pdf
- *Defence Youth Manual*, Part 2, Section 4, Chapter 4 — *ADF Cadets Information
  and Communication Technology*, paras 4.4.2, 4.4.5(c), 4.4.6, 4.4.7.
  https://www.defenceyouth.gov.au/media/iwifjcvu/section-4-chapter-4-adf-cadets-ict-policy.pdf
- *Defence Youth Manual*, Part 2, Section 4, Chapter 3 — *ADF Cadets Records
  Management*.
  https://www.defenceyouth.gov.au/media/r4gmwocn/section-4-chapter-3-adf-cadets-records-management-policy.pdf
- *Defence Youth Safety Framework*.
  https://www.defenceyouth.gov.au/resources/defence-youth-safety-framework/
- *Defence Privacy Policy*.
  https://www.defence.gov.au/about/governance/privacy-policy

**Child safety**
- *Commonwealth Child Safe Framework*, Second Edition, December 2020. National
  Office for Child Safety. Applies to all non-corporate Commonwealth entities (§1.4).
  https://www.childsafety.gov.au/system/files/2024-05/commonwealth-child-safe-framework-2nd-edition.PDF
- *National Principles for Child Safe Organisations* (10 principles; endorsed by
  COAG, 1 February 2019) — key action areas 1.6 and 5.3; Principle 10.
  https://www.childsafety.gov.au/system/files/2026-07/national-principles-for-child-safe-organisations.pdf
- *UN Convention on the Rights of the Child*, Article 16.

**Security**
- *Protective Security Policy Framework*, Release 2026. Department of Home
  Affairs, 1 July 2026 — Requirements 0059, 0060, 0061, 0062; §15.2 (Requirements
  0109, 0111).
  https://www.protectivesecurity.gov.au/publications-library/pspf-annual-release-2026
- *Information Security Manual* — *Guidelines for cryptography*, ASD, June 2026 —
  ISM-1769, ISM-0479.
  https://www.cyber.gov.au/business-government/asds-cyber-security-frameworks/ism/cyber-security-guidelines/guidelines-for-cryptography

**Records**
- National Archives of Australia, **Records Authority 2019/00457762** — Department
  of Defence, Defence Youth and Cadets.
  https://www.naa.gov.au/sites/default/files/2020-08/agency-ra-2019-00457762.pdf

**Privacy guidance**
- OAIC, *Guide to securing personal information*.
  https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/handling-personal-information/guide-to-securing-personal-information

---

## 12. What is sought

1. **Guidance on the correct pathway** for a unit-level Q-Store capability, given
   the gap at §3.
2. **A decision on interim use** — whether continued trial use under the controls
   at §5, with the limitations at §7 understood, is acceptable, and on what terms.
3. **Direction on records management** — application of NAA Records Authority
   2019/00457762 to locally held Q-Store records (§7.6).
4. **Identification of a sponsor**, should Defence consider the capability worth
   pursuing beyond the current units.
5. **Indication of whether the licensing intent at §8 is workable**, before
   binding terms are drafted. In particular whether the field-of-use limit and
   the express permission for paid third-party services (§8.3) fit Defence's
   requirements, and what is required on source access and continuity (§8.6).

No payment is sought. No decision is sought on the basis of this document alone,
and no assurance is offered beyond what is stated in it.

---

## Document control

| | |
|---|---|
| Version | 0.1 DRAFT |
| Author | [NAME] |
| Reviewed by | [ ] |
| Software version | QStore IMS v2.3.0, Defence build |
| Build ID | [STAMP THE DELIVERED BUILD ID] |

**Before submission, complete every `[TO BE COMPLETED]` marker.** Each one is a
statement of fact that the author must be able to substantiate. They are left
blank deliberately: a plausible-sounding placeholder that turns out to be wrong
would do more damage to this submission than an honest gap.
