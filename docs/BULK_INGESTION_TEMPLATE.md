# Bulk Lead Ingestion — CSV Template

**Download the canonical template:** [`bulk-lead-template.csv`](./bulk-lead-template.csv)
**API endpoint (serves it):** `GET /api/v1/bulk/leads/template`

Institutes can use this exact template **as-is**, or upload any CSV and map their columns to CRM fields during the preview step.

---

## Column groups

### 1. Personal (required: at least one of first_name / email / phone / whatsapp_number)
| Column | Type | Notes |
|---|---|---|
| `first_name` | text | |
| `last_name` | text | |
| `email` | email | Case-insensitive unique within tenant |
| `alternate_email` | email | |
| `phone` | text | Must include country code (+91…) for Indian DLT compliance |
| `whatsapp_number` | text | Defaults to `phone` if omitted |
| `alternate_contact` | text | |
| `gender` | Male/Female/Other | |
| `language` | ISO code | `en`, `hi`, `ta`, etc. Drives template-language selection. Default `en` |

### 2. Education (optional)
`ug_degree`, `ug_specialization`, `ug_university`, `ug_graduation_year`
`pg_degree`, `pg_specialization`, `pg_university`, `pg_graduation_year`

Use the dictionary values from `/api/v1/dropdowns/degrees`, `/specializations`, `/universities`. Unknown values trigger a preview warning.

### 3. Address
`country`, `state`, `district`, `city`, `address`, `pincode`

### 4. Program & Pipeline
| Column | Notes |
|---|---|
| `program` | Matched by name OR code against `/api/v1/programs` |
| `stage` | Matched by `lead_stages.name` or `code` (e.g. `New` or `01-New`) |
| `sub_stage` | Matched by `lead_sub_stages.name` scoped to the stage |
| `remarks` | Freeform |

### 5. Family (all optional)
`father_name`, `father_mobile`, `father_email`
`mother_name`, `mother_mobile`, `mother_email`
`guardian_name`, `guardian_mobile`, `guardian_email`

### 6. Source attribution
`channel` · `source` · `campaign` · `medium`

Matched against `/api/v1/dropdowns/channels`, `/sources`, `/campaigns`, `/mediums`. Unknown values → created if `defaults.create_missing_source=true`, else warning.

### 7. Ownership
| Column | Notes |
|---|---|
| `assigned_to_email` | Match to `users.email`. If blank, the **assignment rules engine** picks an owner (round-robin). |

### 8. Referrals
`referral_code_used` — matches `lead_referral_codes.code`.

### 9. Tags
`tags` — semicolon-separated list, e.g. `priority;hot`.

### 10. Custom fields
Any additional column whose header matches a `custom_field_definitions.key` is written to `lead_custom_values`. Unknown headers → ignored (flagged in preview).

---

## Upload flow (3 steps)

1. **Upload the CSV to R2** — `POST /api/v1/uploads/presign` → PUT file → `POST /api/v1/uploads/confirm`.
2. **Preview** — `POST /api/v1/bulk/leads/preview` with `{ r2_key, field_mapping, defaults }`. Worker validates every row, detects duplicates, and writes a preview row. Poll `GET /bulk/leads/previews/:id` for status + sample errors.
3. **Commit** — `POST /api/v1/bulk/leads/commit` with `{ preview_id, duplicate_handling, send_welcome_email, send_welcome_sms }`. `duplicate_handling` options:
   - `skip` — leads that match an existing phone/email are skipped (default).
   - `update_existing` — existing lead is updated with CSV values (non-blank wins).
   - `create_new` — duplicates are allowed (not recommended).

Check `GET /bulk/leads/imports/:id` + `/failures` for per-row results.

---

## Field mapping

If your CSV headers don't match the template, pass a `field_mapping` object keyed by **your column name → CRM field name**:

```json
{
  "field_mapping": {
    "Applicant Name": "first_name",
    "Contact Number": "phone",
    "Email Address": "email",
    "Course": "program"
  },
  "defaults": {
    "channel": "Facebook",
    "source": "Website",
    "stage": "New",
    "sub_stage": "Not Called"
  }
}
```

Defaults are applied to any row missing that field.

---

## Row-level validation rules

- **At least one contact field** (email, phone, whatsapp_number) **or** a name must be present.
- **Phone format**: if provided, must contain 7+ digits. Country code optional but recommended.
- **Email**: must parse as a valid email address.
- **Year fields** must be 4-digit integers.
- **Program/stage/channel values** must exist in the tenant's dropdown tables (unless `defaults.create_missing_*` is set).
- **Duplicates** within the file itself are also detected and reported.

Rows that fail validation end up in `bulk_import_failures` with the specific error code + message, and can be retried via `POST /bulk/leads/imports/:id/retry-failures`.
