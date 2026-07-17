# QStore IMS — Response to HQ AAC ICT, and Controls Statement

**Status:** DRAFT for internal review — not yet sent
**Responds to:** CPL James Jenkins, Acting Systems Administrator, HQ Australian Army Cadets — email thread *"Re: In unit Qstore software [SEC=OFFICIAL]"*, 16 and 17 July 2026
**Applies to:** QStore IMS v2.3.0
**Prepared by:** LT(AAC) Sean Scales, Officer Commanding, 145 ACU Moranbah — [CONFIRM]
**Date:** [DATE]
**Classification:** OFFICIAL — [CONFIRM; see §11]

---

## 1. Purpose

This document responds to HQ AAC ICT advice of 16 and 17 July 2026, records the
controls in the software, corrects two inaccuracies in my earlier description of
it, and sets out a design that removes the objection rather than mitigating it.

HQ has advised (17 July) that it would see no issue with an asset tracking tool
carrying no PII. This document records what that condition requires, states
plainly that the software as it stands does not meet it (§4), and does not treat
that advice as covering the current version.

It is **not** a claim of compliance. Compliance is HQ's determination to make. The
purpose here is to give that determination an accurate basis — including the
matters that count against the software.

---

## 2. The test that applies

HQ's advice does not turn on where data is stored. It turns on **how long** and
**in what aggregate**:

> *"Being that you're storing the Cadet ID, First and Last Name of all the cadets
> in your unit; what you've described is not permissible as you're storing a
> **persistent database of PII, and doing so in aggregate**."*
>
> *"Whilst I accept that units can and do run routine reports, maintain roll books
> and other AAC data offline, **these situations are transitory**. Once there is
> no enduring need to retain the data on local devices, it should be removed."*
>
> — CPL Jenkins, 16 July 2026

The governing distinction is therefore **transitory versus persistent**, not local
versus cloud. This is accepted without argument. It is recorded here explicitly
because it is the test the rest of this document is measured against, and because
my earlier correspondence framed the question in terms of storage location, which
was the wrong frame.

HQ's stated remedy for Q records is equally specific:

> *"The same would apply for a physical Q record, where that record needs to be
> scanned and added to the individual cadets CEA documents."*
>
> *"My immediate recommendation would be to produce PDF based exports of your
> respective cadet Q records, and upload them to the individual members CEA
> documents."*

The design at §5 implements that recommendation.

**HQ's further advice of 17 July 2026**, in response to that design, states the
condition and the records boundary:

> *"Yes, I would take this to be a low risk activity occurring locally. **So long
> as you're not carrying PII and it's purely for asset tracking, I'd see no
> issue.**"*
>
> *"**The point at which it becomes a record is when it needs to end up in CEA or
> CadetNet.** For example, you complete a stock take, that completed stock take
> report must be stored in CadetNet as it's a record."*
>
> — CPL Jenkins, 17 July 2026

Two things follow, and they govern the rest of this document:

1. **The condition is that no personal information is carried.** HQ's position is
   not that local storage is objectionable, nor that persistence is objectionable
   in itself — it is that a persistent aggregate of PII is. An asset dataset
   holding no personal information does not engage the objection.
2. **The record is the output, not the working data.** A completed stock take
   report, or a Q record, is the Commonwealth record, and it belongs in CEA or
   CadetNet. The software is a working tool that produces those artefacts; it is
   not the system of record and does not hold one.

---

## 3. The capability gap — acknowledged by HQ

> *"Beyond this, we're aware that there is a **distinct lack of CadetNet
> capability in terms of individual Q-record management** and will continue to
> advocate for inclusion of said capability in CEA."*
>
> — CPL Jenkins, 16 July 2026

This is HQ's own assessment, offered unprompted. The unit's requirement is not in
dispute and no approved system currently meets it. In its absence, units record
Q-Store holdings by other local means — spreadsheets, paper, or nothing.

Nothing in this document seeks to work around that gap. What is proposed is a tool
that operates **entirely inside** the constraint at §2 while the capability is
advocated for, and which produces exactly the artefacts (§5) that HQ has said
should go to CEA.

---

## 4. Current state — and what it does not resolve

Stated plainly, because it is the substance of HQ's objection:

**The software as it exists today holds a persistent, aggregate dataset of cadet
identifiers (service number, surname, given name, rank) and therefore does not
meet the test at §2.** Recent changes reduce the exposure; they do not answer the
objection.

| Change made | Effect | Meets §2? |
|---|---|---|
| Cloud synchronisation removed entirely from the Defence build (compiled out, not disabled — §6.1) | No data leaves the device | **No** — persistence is the objection, not location |
| Cadet email addresses and free-text notes removed from the schema, with a migration deleting them from existing records (§6.2) | Sensitive information no longer held | **No** — reduces the dataset, does not make it transitory |
| Encryption, access control, audit (§6.3–§6.6) | Reduces harm from compromise | **No** — controls on a dataset that should not persist |

These are worth having on their own merits. **None of them removes the personal
information, and I do not present them as answering HQ's objection.** HQ's advice
of 17 July, which sees no issue with a tool carrying no PII, is not treated as
covering this version.

---

## 5. Design — no individual identifiers at all

This implements HQ's recommendation rather than seeking an exemption from it, and
HQ has advised (17 July 2026, §2) that it would see no issue with such a tool
provided no PII is carried and it is purely for asset tracking.

**The software would hold no cadet identifiers of any kind.** No service number,
no name, no rank. It becomes an equipment accountability tool:

- Stock, condition, stocktake, write-off (AB174), and orders — none of which
  involve a person.
- Items issued to an individual are recorded only as **location: individual**,
  against an **issue number**.
- The issue document (AB189, Issue Voucher, kit checklist) is produced with
  identifier fields **blank**, printed, and completed by hand.
- The completed document is scanned or saved to PDF and **uploaded to that
  individual's CEA documents** — per HQ's recommendation at §2.
- The person↔equipment link therefore exists **only in CEA**, which is the system
  of record for it.

**Effect against the test at §2.** There is no persistent database of PII, in
aggregate or otherwise, because there is no PII. The residual dataset is equipment
counts and document reference numbers.

**One qualification, stated rather than glossed.** The issue number is a linkage:
given the number and access to CEA documents, the unit can identify the holder.
Identifiability is assessed relative to the entity holding the data, and the unit
holds both. **No claim of de-identification is made.** What is claimed is narrower
and, I suggest, sufficient: the software itself holds nothing about any person;
re-identification requires a manual document lookup in an approved system rather
than a database query; and the dataset in the software is of no use to anyone who
obtains it.

**Known consequences, so they are not discovered later:**

- Overdue tracking, discharge recall, and per-person kit checklists are lost as
  automated functions. Chasing an outstanding item becomes a documents task.
- Double handling: the issue is recorded once in the software and once in CEA.
- Free-text fields are the obvious failure mode — a user will otherwise type a
  name into an activity or location field. Person-adjacent free text must be
  designed out, not merely discouraged.

**The condition is load-bearing.** HQ's advice is expressly conditional on the
tool not carrying PII. That makes the elimination of person-adjacent free text a
**condition of the advice**, not a design preference: the moment a user types a
name into an activity, location, or remarks field, the tool is carrying PII and
the basis of HQ's position no longer holds. Free-text fields capable of holding a
person's details will therefore be removed rather than discouraged, and this is
recorded here so that the constraint is understood as binding rather than
aspirational.

**Status: designed, not built.** It is a substantial change and is not presented
as existing. HQ's advice of 17 July is understood as applying to a tool of this
description — **not** to the version currently held at the trial units, which does
carry cadet identifiers (§4) and which I do not treat as covered.

---

## 6. Controls

> **Basis of these statements.** Each was verified by reading the implementation
> on 17 July 2026, not by relying on prior documentation. That distinction matters
> here: the defect at §10 existed precisely because a documented description of
> the code was trusted and the code was not re-read. A second instance was found
> during preparation — an internal comment describing the account lockout policy
> stated durations thirty times shorter than the code applies. The code was
> correct; the comment was stale. Both are corrected.

### 6.1 No cloud egress (Defence build)

The Defence build has **no capability to transmit data to third-party cloud
storage**. This is not a setting that has been switched off: the synchronisation
code, the Microsoft Authentication Library, and the Microsoft Graph endpoints are
**not present in the artefact**. They are removed at build time.

Stated as a verifiable property rather than an assurance — the delivered file can
be searched for `graph.microsoft.com`, `msal`, and the OneDrive API paths and
contains none of them. An automated test enforces this on every build, and first
confirms the *standard* build does contain those strings, so that their absence is
a meaningful result rather than a vacuous one.

Relevant to Defence Youth Manual Pt 2 S4 Ch4 para 4.4.5(c). **It does not address
the objection at §2**, and is not offered as doing so.

### 6.2 Data minimisation

Cadet email addresses and free-text notes have been removed from the schema, and a
migration deletes both from records created before the change — gone from the
stored data, not hidden from the interface. Free text about a child attracts health
and behavioural information, which is **sensitive information** under the *Privacy
Act 1988* and attracts stricter handling; none of it is required to record who
holds an item of equipment. Staff records (adults) retain both fields.

### 6.3 Encryption of personal information at rest

Personal information fields are individually encrypted with **AES-256-GCM** using
a key generated and held on the device. AES is the only approved symmetric
algorithm under the ASD *Information Security Manual* — *Guidelines for
cryptography*, and **ISM-1769** provides that AES-256 is preferred. GCM is an
authenticated mode; **ISM-0479** prohibits ECB, which is not used.

> **Correction to my email of 15 July 2026.** I described the software as having
> "SHA256 encryption". That was inaccurate. SHA-256 is a hash function, not
> encryption. The correct position is: **AES-256-GCM** for personal information at
> rest; **HMAC-SHA256** for the audit chain; **argon2id** for PIN hashing.

### 6.4 Access control and authentication

- Per-user PINs hashed with **argon2id**.
- **TOTP two-factor authentication** (RFC 6238), SHA-256-hashed single-use backup
  codes, replay guard.
- Roles: Commanding Officer, Quartermaster, Staff, Cadet, Read-Only.
- **Cadet isolation:** cadet accounts see only their own records; the staff
  register is inaccessible to them; the login picker shows surname and first
  initial only.
- Escalating lockout: 5 consecutive failures → 15 minutes; 10 → 30; 15+ → 60.
- Idle auto-lock: default 15 minutes, minimum 5, **no disable option** — a stored
  zero is rejected and the default applied. The lock screen requires the PIN and,
  where enabled, the second factor; the session token is removed from browser
  storage while locked.

### 6.5 Audit

Append-only log, entries chained with **HMAC-SHA256**, each signature
incorporating the previous entry's hash, so retrospective alteration is
detectable. Read access to cadet and staff records is itself audited. The
guarantee is qualified — see §10.

### 6.6 Backups and key management

Export produces an **encrypted file only**; there is no unencrypted option. Key
derivation is PBKDF2-HMAC-SHA256 at 310,000 iterations with a random 32-byte salt,
encrypting under AES-256-GCM.

> **Attribution.** The 310,000-iteration figure follows **OWASP** guidance. It is
> **not** an ASD or ISM requirement: PBKDF2 is not addressed in the ISM's
> *Guidelines for cryptography* and is not an ASD-Approved Cryptographic
> Algorithm. The same applies to argon2id. These are considered appropriate
> engineering choices; they are **not** presented as ASD-approved.

An operator-initiated key rotation re-encrypts all personal information under a
newly generated key and re-signs the audit chain — see §10 for why it exists and
what it does not achieve.

---

## 7. Privacy obligations

| Obligation | Status |
|---|---|
| APP 1 — open and transparent management | Partial — no published privacy policy for this software |
| APP 3 — collection of solicited personal information | Minimised (§6.2); eliminated entirely under §5 |
| APP 5 — notification of collection | **Not implemented — see §8.4** |
| APP 6 — use or disclosure | Data does not leave the device (Defence build) |
| APP 8 — cross-border disclosure | Not applicable — no transmission path |
| APP 11 — security of personal information | Controls at §6 |
| APP 12 / 13 — access and correction | Records directly viewable and editable by unit staff |

Defence Youth Manual Section 1, Chapter 2 para 50 records the obligation under the
*Privacy Act 1988* and **Article 16 of the UN Convention on the Rights of the
Child**.

---

## 8. Known limitations and residual risk

### 8.1 The dataset is currently persistent
As at §4 — the substance of HQ's objection, unresolved until §5 is implemented.

### 8.2 No accreditation
DYM Pt 2 S4 Ch4 para 4.4.6 anticipates ADF Cadets ICT systems holding current
**Defence Digital Group security accreditation** against the ISM. This software
holds none, has not had an **IRAP assessment**, and has not been independently
penetration tested. No claim of accreditation is made or implied.

### 8.3 Some personal information is not encrypted at rest
Equipment-request requestor name, rank and service number, and the stocktake
"counted by" name, are **stored in plain text**. The encryption module defines
these fields but the storage layer does not apply them. This is a defect. It is
disclosed here rather than found later, and is eliminated entirely under §5.

### 8.4 Mandatory privacy statement not present
DYM Section 1, Chapter 2 para 55 requires a specified privacy statement on all
documentation and **information technology systems** where Defence collects
information relating to youth. The software does not carry it. Straightforward
non-compliance; being remediated.

### 8.5 Records management — resolved by HQ's advice
This was recorded as an unresolved gap in the previous version of this document,
on the assumption that loan and issue history held in the software constituted
Commonwealth records that it had no schedule to retain or dispose of. HQ's advice
of 17 July 2026 resolves it:

> *"The point at which it becomes a record is when it needs to end up in CEA or
> CadetNet. For example, you complete a stock take, that completed stock take
> report must be stored in CadetNet as it's a record."*

The record is therefore the **output** — the completed stock take report, the Q
record — and it belongs in CEA or CadetNet. The software's working data is not the
record. Under the design at §5 that boundary is explicit: the software produces
the artefact, the artefact goes to CEA, and CEA holds the record.

DYM Section 1, Chapter 2 para 67 obligations under the *Archives Act 1983*, and
**NAA Records Authority 2019/00457762**, attach to the records in CEA. **I do not
propose to destroy any existing record on my own initiative** — direction on the
disposal of the current dataset is sought at §13.

### 8.6 Device-level compromise is out of scope
Encryption at rest protects data copied off the device. It does not protect
against an attacker with live access to an unlocked session on the device itself.
Documented and accepted.

### 8.7 No Privacy Impact Assessment
A system holding personal information about minors is likely a high privacy risk
project, for which a **Privacy Impact Assessment** is required of Commonwealth
agencies. None has been conducted.

### 8.8 Support model and key person risk
Maintained by one person. No support agreement, no service level, no independent
vulnerability management, no source code escrow. **The key person risk is total.**

### 8.9 Commercial interest — declaration
I maintain QStore as a commercially licensed product outside ADF Cadets. I am also
the Officer Commanding of a unit that uses it. That is a conflict of interest and
is declared here rather than left to be discovered.

**No payment is sought from the Commonwealth.** The Defence build is offered free
of charge for ADF Cadets use; no licence fee, subscription, or per-unit charge is
sought now or in future. Terms are at §9. Nothing in this document is a request
for procurement.

The residual interest, stated so it can be weighed rather than inferred: I retain
a commercial product line outside ADF Cadets, and adoption would raise its
profile. That is a real interest, and it is why this declaration exists.

> **[TO BE COMPLETED]** Confirm the ownership position: whether any part of QStore
> was developed while performing cadet duties, on Defence equipment, or using
> Defence information. **You can only license what you own; settle this before any
> offer, not during assessment.**

---

## 9. Licensing

> **Statement of intent, not licence terms.** Not settled by a lawyer, and not an
> offer capable of acceptance. Binding terms require drafting and review.

- **Intent:** the Defence build is offered **free of charge** for ADF Cadets use.
- **Grant:** royalty-free, non-exclusive, perpetual licence to the Commonwealth to
  use, install and modify it for ADF Cadets purposes.
- **Expressly permitted, including paid work:** engagement of third parties, for
  payment, to provide services to the Commonwealth in respect of this software —
  hosting, security assessment and accreditation, integration, maintenance,
  support. Any accreditation pathway runs through paid contractors; a licence
  readable as prohibiting that would make the software unadoptable, which serves
  nobody. **Being paid to accredit, host or support this software for the
  Commonwealth is not what this licence restricts.**
- **Not permitted:** sale, resale, sublicensing, redistribution outside ADF
  Cadets, incorporation into a product offered for sale, or rebadging as a third
  party's product.
- **Reserved:** all other rights, including the commercial line outside ADF
  Cadets. The Defence build is a distinct, functionally narrower variant.
- **Source access:** accreditation requires code review; source will be made
  available for assessment. Terms beyond assessment require decision.
- **Continuity:** given §8.8, escrow or a fallback grant if maintenance ceases
  should form part of any agreement. **[TO BE DECIDED]**

---

## 10. Disclosure — security defect identified and remediated

Disclosed voluntarily and in full.

**What it was.** The database snapshot included an internal metadata store holding
two secrets: the AES-256-GCM key protecting all personal information, and the HMAC
key underwriting the audit chain. The synchronisation routine wrote that snapshot
to cloud storage as plain JSON, and the file export offered an unencrypted option
that wrote the same content to disk. **Any such file therefore contained both the
encrypted personal information and the key required to decrypt it.** The
encryption control was void for data leaving the device, and audit entries written
before remediation could be forged by anyone holding such a file.

> **Correction to my email of 15 July 2026.** I stated that "backed up information
> is also encrypted." **That was not correct**, and I did not know it at the time.
> The backup was encrypted, but carried its own key. I am correcting the record
> rather than leaving an inaccurate statement standing.

**How it arose.** The restore routine carried a documented justification for
including the metadata store — preserving audit chain verifiability across
devices. That justification is sound and referred only to the audit key and
installation identifier. It predates personal-information encryption. When the
encryption key was later added to the same store it inherited that export path
silently, carrying a rationale that had nothing to do with personal information.
No test asserted that key material was absent from exported data. The defect was
found by reading the code, not by a failure.

**Remediation.**

| Action | Status |
|---|---|
| Cloud transmission removed entirely from the Defence build | Complete |
| Export encryption mandatory; unencrypted option removed | Complete |
| Key rotation implemented (new key, all data re-encrypted) | Complete |
| Automated tests asserting key material is absent from exports | Complete |
| Cloud file deleted from affected storage, including version history | [TO BE CONFIRMED] |
| Trial units notified; use suspended pending remediation | [TO BE CONFIRMED] |

**What rotation does not fix.** Rotating the encryption key restores
confidentiality going forward. **Rotating the audit key does not restore the
integrity guarantee for entries written before rotation.** The chain is an HMAC
construction: once the key was exposed, every pre-rotation entry became forgeable,
and no later action undoes that. Re-signing under a new key makes verification
pass, but re-signing is exactly what a forger would do. **Only entries after the
rotation marker carry a meaningful guarantee.** The software records this boundary
permanently in the audit log, in those terms.

**Exposure assessment.**

| Question | Finding |
|---|---|
| Was the affected file or folder ever shared with any party? | **No** |
| Any known access by an unauthorised person? | [TO BE COMPLETED] |
| Accounts with access to the storage | [TO BE COMPLETED] |
| Multi-factor authentication enabled on those accounts? | [TO BE COMPLETED] |
| Any copy downloaded, emailed, or retained elsewhere? | [TO BE COMPLETED] |

Under **Part IIIC of the *Privacy Act 1988***, an eligible data breach requires
unauthorised access, disclosure, or loss, together with a likelihood of serious
harm (**s 26WE**, **s 26WG**). The file was never shared, which closes the
principal disclosure vector, and on that basis there may be **no eligible data
breach** — the defect created the capacity for compromise rather than compromise
itself. That assessment is not complete until the remaining questions are
answered. Where there are reasonable grounds to suspect an eligible data breach,
**s 26WH** requires assessment within **30 days**. Sensitivity is heightened
because the affected individuals are minors.

**Note.** Rotation and deletion are not alternatives. Any surviving copy of a
pre-fix file carries its own key and remains readable by whoever holds it.
Deletion of those files, including version history, is a distinct necessary step.

---

## 11. Classification

No classification is asserted. Under the **Protective Security Policy Framework
(Release 2026)** the originator assesses potential damage (**Requirement 0059**)
and sets the classification at the **lowest reasonable level** (**Requirement
0060**).

The PSPF statement sometimes quoted as "personal information will always be
classified at least OFFICIAL: Sensitive" appears within the security-clearance
vetting context and is scoped to it. It is **not** relied on here.

---

## 12. References

Verified against publicly available primary sources on **17 July 2026**.
Instruments that are Defence-intranet-only could not be verified and are **not**
cited.

**Legislation**
- *Privacy Act 1988* (Cth), Schedule 1 — Australian Privacy Principles.
  https://www.oaic.gov.au/privacy/australian-privacy-principles/read-the-australian-privacy-principles
- *Privacy Act 1988* (Cth), **Part IIIC** — Notifiable Data Breaches scheme.
  https://www.oaic.gov.au/privacy/notifiable-data-breaches/about-the-notifiable-data-breaches-scheme
- *Defence Act 1903* (Cth), **Part V — Australian Defence Force Cadets**, ss 62–62E.
  Compilation C2026C00299, 1 July 2026. https://www.legislation.gov.au/C1903A00020/latest/text
- *Defence Regulation 2016*, **Part 15A — Australian Defence Force Cadets**. (The
  *Cadet Forces Regulation 2013* is **repealed** and is not the operative
  instrument, notwithstanding its continued citation in secondary sources.)
- *Archives Act 1983* (Cth).

**Defence**
- *Defence Youth Manual*, Edition 1, Head Reserve and Cadet Support, 11 July 2025,
  OFFICIAL — Section 1, Chapter 2, paras 50, 55, 62, 67.
  https://www.defenceyouth.gov.au/media/iobfus5d/defence-youth-manual.pdf
- *Defence Youth Manual*, Pt 2, S4, Ch4 — *ADF Cadets ICT*, paras 4.4.2, 4.4.5(c),
  4.4.6, 4.4.7.
  https://www.defenceyouth.gov.au/media/iwifjcvu/section-4-chapter-4-adf-cadets-ict-policy.pdf
- *Defence Youth Manual*, Pt 2, S4, Ch3 — *ADF Cadets Records Management*.
  https://www.defenceyouth.gov.au/media/r4gmwocn/section-4-chapter-3-adf-cadets-records-management-policy.pdf
- *Defence Privacy Policy*. https://www.defence.gov.au/about/governance/privacy-policy

**Child safety**
- *Commonwealth Child Safe Framework*, 2nd ed., December 2020, National Office for
  Child Safety — applies to all non-corporate Commonwealth entities (§1.4).
  https://www.childsafety.gov.au/system/files/2024-05/commonwealth-child-safe-framework-2nd-edition.PDF
- *National Principles for Child Safe Organisations* (10 principles; COAG endorsed
  1 February 2019) — key action areas 1.6, 5.3; Principle 10.
  https://www.childsafety.gov.au/system/files/2026-07/national-principles-for-child-safe-organisations.pdf
- *UN Convention on the Rights of the Child*, Article 16.

**Security**
- *Protective Security Policy Framework*, Release 2026, Department of Home Affairs,
  1 July 2026 — Requirements 0059, 0060, 0061, 0062.
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

> **Terminology.** **CEA** is the version 5 platform on which all ADF Cadets
> administration is conducted, and is the system referred to throughout HQ's
> correspondence. The *Defence Youth Manual* (Edition 1, 2025) describes
> **CadetNet** at para 4.4.2 as the approved system for managing personnel,
> logistics, facilities, training and cadet activities. This document uses each
> term as its source does, and treats CEA as the operative platform. Note that HQ's
> own advice uses both in one sentence — *"a distinct lack of CadetNet capability
> in terms of individual Q-record management … advocate for inclusion of said
> capability in CEA"* — so the naming appears to be in transition rather than
> denoting two unrelated systems.

---

## 13. What is sought

1. **Direction on disposal of the current dataset.** On HQ's advice the existing
   persistent cadet data should not be retained. I propose to extract what is
   required into CEA documents and then delete the local dataset. Confirmation of
   the correct process is sought — **I do not intend to destroy a record on my own
   initiative** (§8.5).
2. **Acceptance of the CadetNet M365 offer.** CPL Jenkins offered assistance with
   a solution in CadetNet M365, and a secured staff-only library or list. I would
   like to take that up.
3. **Confirmation once built.** HQ's advice of 17 July is understood as applying
   in principle to a tool carrying no PII. Once the design at §5 exists, I would
   welcome the opportunity to have it examined against that condition rather than
   relying on my own assessment that it meets it.
4. **Support for the CEA Q-record capability** referred to at §3. If the unit's
   experience or this software is useful evidence for that business case, it is
   available for that purpose, at no cost and with no expectation.

**Already addressed, and recorded here for completeness:** whether an asset
tracking tool holding no individual identifiers is permissible (HQ advice, 17 July
2026 — §2), and where the boundary of a Commonwealth record falls (same, §8.5).

No payment is sought. No decision is sought on the basis of this document alone,
and no assurance is offered beyond what is stated in it.

---

## Document control

| | |
|---|---|
| Version | 0.3 DRAFT — updated following HQ AAC ICT advice of 16 and 17 July 2026 |
| Author | [NAME] |
| Software version | QStore IMS v2.3.0 |
| Build ID | [STAMP THE DELIVERED BUILD ID] |

**Complete every `[TO BE COMPLETED]` / `[CONFIRM]` marker before sending.** Each is
a statement of fact requiring substantiation. They are blank deliberately: a
plausible placeholder that turns out to be wrong would do more damage than an
honest gap.
