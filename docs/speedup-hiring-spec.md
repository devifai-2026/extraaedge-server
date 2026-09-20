# Speedup Hiring — feature spec

Internal staff recruitment for the tenant's own team. Owned by `hr_recruiter`,
reporting to `hr_team_lead`.

Status: **proposed, not built.** This is a scoping document.

---

## 1. Why this is a new module, not an extension of Placement

Placement looks like a close match — it already has companies, job openings,
applications and tenant-defined pipeline stages. It is not reusable:

```sql
CREATE TABLE job_applications (
  opening_id uuid NOT NULL REFERENCES job_openings(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  ...
```

`student_id` is a **NOT NULL FK to `students`**. Placement exists to put *our
enrolled students* into *other companies' jobs*. Speedup Hiring is the mirror
image: *external candidates* applying to *our own* vacancies. A candidate is
not a student and must never be forced into that table.

Options considered:

| Option | Verdict |
|---|---|
| Reuse `job_applications` with a nullable `student_id` | Rejected. Two unrelated populations in one table, every placement query needs a new guard, and the placement team's reports silently start counting job applicants. |
| Create a synthetic `students` row per candidate | Rejected. Pollutes student counts, LMS rosters, certificates and the student portal. |
| New `hiring_*` tables | **Chosen.** Placement's *shape* is a good template — copy the pattern, not the tables. |

The pipeline-stage pattern (`placement_stages` + `application_stage_history`)
is worth copying closely: it already solves "tenant defines its own statuses",
which this feature needs (see §4).

---

## 2. Data model

### `hiring_positions`
The vacancy being recruited for. "Telecaller", "Placement Coordinator".

| Column | Notes |
|---|---|
| `id` | uuid pk |
| `title` | text, e.g. "Telecaller" |
| `department` | text, nullable |
| `branch_id` | FK `branches`, nullable — which office is hiring |
| `openings_count` | int, default 1 |
| `status` | `open` / `on_hold` / `closed` |
| `opened_at`, `closed_at` | timestamptz |
| `created_by` | FK `users` |

### `hiring_candidates`
One row per person. Columns are taken directly from the two spreadsheets
supplied, which are the source of truth for what HR actually records.

| Column | From sheet | Notes |
|---|---|---|
| `contacted_on` | "Date of contact" | date |
| `position_id` | "Position applied for" | FK `hiring_positions` |
| `name` | "Name" | required |
| `phone` | "Contact No" | required-ish; see §6 on dedup |
| `email` | "Email id" | frequently blank in the sample data |
| `location` | "Location" | city |
| `highest_qualification` | "Highest Qualification" | free text (B.C.A, 12th Pass, BSC…) |
| `stream` | "Stream" | Science / Commerce / … |
| `experience_level` | "Work Experience" | `fresher` / `experienced` |
| `current_area` | "Current Location with area" | free text |
| `current_salary` | "Current Salary" | numeric, nullable |
| `expected_salary` | "Expected Salary" | numeric, nullable |
| `notice_period` | "Notice Period" | free text ("immediate joiner") |
| `status_id` | "Interview Done" / outcome | FK `hiring_statuses`, see §4 |
| `remark` | "Remark" / "1st Remark" | text |
| `remark_2` | "2nd Remark" | text |
| `source` | — | which channel they came from, see §3 |
| `owner_id` | — | FK `users`, the recruiter working them |

Salary fields arrive as `"17,000/-"` and must be parsed on import — store
numeric, render formatted.

### `hiring_interviews`
The second sheet is an interview line, one row per scheduled interview. A
candidate can be interviewed more than once, so this is a child table rather
than columns on the candidate.

**This cannot reuse the existing interviews module.** That module is for
STUDENT MOCK INTERVIEWS — placement practice, not hiring:

```sql
CREATE TABLE mock_interviews (
  program_id uuid NOT NULL REFERENCES programs(id) ...
CREATE TABLE interview_slots (
  student_id uuid NOT NULL REFERENCES students(id) ...
```

An interview there hangs off a **course** and its attendees are **enrolled
students**. A trainer creates it and nominates an HR person to score soft-skill
categories — which is why the recruiter's current screen reads "Interviews a
trainer assigns you as the HR evaluator will appear here" and is permanently
empty. There is no way to express "interview Akanksha for the Telecaller
vacancy" in that schema: she is not a student and Telecaller is not a course.

Surfacing the trainer's scheduling UI to the recruiter would therefore be
actively wrong, not merely unhelpful. Staff-hiring interviews need these
tables.

| Column | From sheet |
|---|---|
| `candidate_id` | FK `hiring_candidates` |
| `scheduled_at` | "Interview Date" + "Interview Time" combined |
| `mode` | "Interview mode" — Online / In-person |
| `status_id` | "Interview status" — FK `hiring_statuses` |
| `interviewer_id` | FK `users`, nullable |
| `remark_1`, `remark_2` | "1st Remark", "2nd Remark" |

### `hiring_statuses`
Tenant-defined. See §4.

### `hiring_channels` and `hiring_postings`
See §3.

---

## 3. Multi-channel job posting

Requirement: post a vacancy to LinkedIn, Facebook, Instagram "and many more".

**Recommendation: start with tracked manual posting, not API integrations.**

A `hiring_postings` row records *that* a position was posted to a channel, with
the URL and the date:

| Column | Notes |
|---|---|
| `position_id` | FK |
| `channel` | `linkedin` / `facebook` / `instagram` / `naukri` / `indeed` / `referral` / `walk_in` / `other` |
| `posted_at`, `posted_by` | |
| `external_url` | link to the live post |
| `notes` | |

The recruiter composes once, copies to each channel, pastes the URLs back. This
gives the thing that actually matters — **which channel produced which
candidate** — without depending on five third-party APIs.

Why not direct API posting now:

- LinkedIn job posting requires Talent Solutions partnership; the public API
  does not cover it.
- Meta's Graph API dropped Facebook Jobs; Instagram has no jobs surface at all.
- Each integration is its own OAuth flow, review process and breakage risk.

A "Post to LinkedIn" button can be added later per channel, behind the same
`hiring_postings` row, without reshaping anything. The `source` field on a
candidate should be a FK to the posting where known, so channel-effectiveness
reporting works from day one.

---

## 4. Configurable statuses

From the brief: *"status can be anything, need to add in configurations by hr
recruiter."*

`hiring_statuses` mirrors `placement_stages`:

| Column | Notes |
|---|---|
| `name` | "Rejected", "Offer Accepted", "Not attend the interview", "Location issue", "Not looking for job", "Not relevant" |
| `kind` | `open` / `hired` / `rejected` — so reports can count outcomes without string-matching names |
| `order_index` | display order |
| `is_active` | soft retire, never delete a status in use |
| `applies_to` | `candidate` / `interview` / `both` |

`kind` matters. Every status in the sample data is a *terminal* outcome
("Rejected", "Offer Accepted", "Location issue"), and without a classifier
every funnel report would hardcode names — exactly the trap the Cold/Junk tab
hit, where `is_success` saved us from matching on the literal string "Junk".

Statuses are edited under Configuration, by `hr_recruiter`. Changes are
append-and-retire, never rename-in-place, so history stays readable.

Stage moves are logged to a `hiring_status_history` table, copying
`application_stage_history`.

---

## 5. Entry paths — three, all required

### a. Manual entry
A "New candidate" form. The primary path for a walk-in or a phone enquiry.

### b. Bulk upload — candidates
**Distinct from the counsellor lead importer.** Different columns, different
target table, different validation. It must not be routed through
`bulk-ingestion`, which maps to `leads`.

Mirror the *pattern* of the existing bulk import — upload → preview with
per-row validation → commit → failure report — because it is proven and the
recruiter already understands that flow. Do not mirror the mapping.

### c. Bulk upload — interviews
The second sheet. Matches to an existing candidate by phone (§6) and creates
`hiring_interviews` rows. Should also accept unknown candidates by creating
them, since in practice the interview sheet sometimes leads.

All three write the same tables, so a candidate added by hand and one imported
are indistinguishable afterwards.

---

## 6. Deduplication

The sample data shows this will bite immediately:

- Rows with **no email** at all (several).
- A row where the Contact No column contains a **name** ("Akshay Ghule / Gayatri
  Vilas Chavan"), not a number.
- The same person will legitimately appear twice for two different positions.

Rules:

- Match on **normalised phone** (digits only, last 10). Email is too often blank.
- A duplicate phone **for the same position** is the same application — update it.
- A duplicate phone **for a different position** is a new candidate row, linked
  to the same person. Worth a `person_key` column grouping them.
- A row whose phone does not parse is **not** silently dropped: it lands in the
  failure report for the recruiter to fix, the same as a failed lead row.

---

## 7. Screens

| Screen | Contents |
|---|---|
| **Hiring dashboard** | Open positions, candidates per stage, interviews this week, offers out. Channel effectiveness once postings exist. |
| **Positions** | List + create/edit. Per position: openings, posted-to channels, candidate count. |
| **Candidates** | The main working list. Filter by position, status, experience, location. Bulk upload button. Row → candidate detail. |
| **Candidate detail** | The full record, interview history, status moves, remarks timeline. |
| **Interviews** | Calendar/list of scheduled interviews for CANDIDATES. Bulk upload. This is where "interview scheduled" from the role brief lives — distinct from HR → Interviews, which is student mock-interview scoring and should arguably be renamed to say so. |
| **Configuration → Hiring statuses** | CRUD for `hiring_statuses`. |

Onboarding hand-off: a candidate at a `hired` status gets a **"Create staff
account"** action that pre-fills the existing user-create form from the
candidate record. `hr_recruiter` now holds `STAFF_ADMIN_ROLES`, so they can
complete it — this is the seam between hiring and the staffing half of the
role.

---

## 8. Permissions

`hr_recruiter` and `hr_team_lead` get full access. `super_admin` sees
everything. No other role should see candidate data — it contains salary
expectations and personal contact details for people who do not work here.

New tab keys: `hiring.dashboard`, `hiring.positions`, `hiring.candidates`,
`hiring.interviews`, `hiring.statuses`.

---

## 9. Build order

1. Schema + statuses config + manual candidate entry. Usable on its own.
2. Candidates list, filters, candidate detail.
3. Bulk upload — candidates.
4. Interviews (schedule, list) + bulk upload — interviews.
5. Positions + `hiring_postings` + channel reporting.
6. Dashboard.
7. *Later, optional:* real API posting per channel.

Steps 1–3 deliver most of the value: the spreadsheets stop being spreadsheets.

---

## 10. Open questions

1. **Is the interview sheet a second view of the same people, or a separate
   intake?** The two sheets share Position/Name/Contact but the columns barely
   overlap. This spec assumes one candidate record with many interviews. Worth
   confirming against how HR actually works today.
2. **Should a rejected candidate be re-approachable later?** If so, candidates
   need a "do not contact" flag and a re-apply history rather than being closed.
3. **Who owns a candidate?** `owner_id` is in the model, but if there is only
   ever one recruiter it may be noise.
4. **Does a hired candidate's data need retaining after onboarding**, and for
   how long? Salary expectations and phone numbers for people who were rejected
   carry a retention question worth answering before launch, not after.
