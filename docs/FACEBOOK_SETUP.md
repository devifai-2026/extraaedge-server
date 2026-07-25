# Facebook (Meta) Setup — Lead Ads → CRM + Custom Audiences

This guide connects a tenant's Facebook assets to ExtraaEdge, in **Development
mode** (no App Review needed for the client's own Business assets). Do this once
per tenant/Business.

Two capabilities:
- **Inbound** — a Facebook Lead Ads form submission auto-creates a CRM lead
  (tagged `channel = Facebook` + the ad campaign, round-robin assigned).
- **Outbound** — push CRM lead segments to Facebook as **Custom Audiences** for
  retargeting (the Remarketing page).

Everything is **per-tenant**: each institute connects its own Page / ad account
/ tokens. Nothing is shared globally.

---

## Part A — Create the Meta App (once)

1. Go to <https://developers.facebook.com/apps> → **Create App** → type **Business**.
   Leave it in **Development** mode (top toggle stays "In development").
2. **Add products** to the app:
   - **Webhooks**
   - **Marketing API** (only needed for Custom Audiences / outbound)
   - (Facebook Login is optional — we use a System-User token instead of OAuth.)
3. **App roles** (App → App Roles → Roles): add anyone who will manage this
   (Admin/Developer/Tester). In Development mode the integration only works for
   people/assets with a role — that's fine for the client's own team.
4. Note the **App Secret** (App → Settings → Basic → App Secret → Show). You'll
   paste this into the CRM so it can verify webhook signatures.

## Part B — Generate a token (once per Business)

Use a **System User** token (long-lived, no OAuth flow):

1. <https://business.facebook.com> → **Business Settings** → **Users → System Users**
   → **Add** → create a System User (Admin).
2. **Assign assets** to that System User:
   - The **Facebook Page** running the Lead Ads (Full control).
   - The **Ad Account** (Manage) — needed for Custom Audiences.
3. **Generate token** for the System User → select the app from Part A → grant
   scopes:
   - Inbound (Lead Ads): `leads_retrieval`, `pages_show_list`,
     `pages_read_engagement`, `pages_manage_metadata`
   - Outbound (Custom Audiences): `ads_management`
4. Copy the generated token — this is the **Page/System-User access token**.

---

## Part C — Connect INBOUND (Lead Ads → CRM leads)

In the CRM (admin, super_admin) create a Facebook integration and register the
webhook. (Backend endpoints already exist — a config screen or these API calls.)

1. **Create the integration** (stores the token + app secret, per-tenant, encrypted):
   `POST /api/v1/integrations`
   ```json
   {
     "type": "facebook_ads",
     "name": "Facebook Lead Ads",
     "credentials": { "page_access_token": "<TOKEN from Part B>", "app_secret": "<App Secret from Part A>" },
     "config_json": {
       "verify_token": "<any-strong-string-you-choose>",
       "default_channel": "Facebook",
       "default_source": "Facebook Lead Ads",
       "default_stage": "<optional lead_stages uuid>",
       "field_mapping": { "name": "full_name", "email": "email", "phone": "phone_number" }
     }
   }
   ```
2. **Mint the webhook URL:** `POST /api/v1/integrations/<id>/webhook-url` →
   returns `{ url, token }`, e.g.
   `https://admissioncrm.live/api/v1/integrations/inbound/<token>`.
3. **In the Meta App → Webhooks:**
   - Product: **Page** → **Subscribe to this object**.
   - **Callback URL:** the `url` from step 2.
   - **Verify Token:** the exact `config_json.verify_token` you set in step 1.
   - Click **Verify and Save** (the CRM answers Meta's `hub.challenge`).
   - Under fields, **subscribe to `leadgen`**.
4. **Subscribe the Page to the app** (App → Webhooks → Page → your Page →
   subscribe `leadgen`), or via Graph: `POST /<page_id>/subscribed_apps` with
   `subscribed_fields=leadgen`.

**Test:** Meta **Lead Ads Testing Tool**
(<https://developers.facebook.com/tools/lead-ads-testing>) → pick the Page + form
→ **Create Lead**. Within seconds a new lead appears in the CRM, tagged
`channel = Facebook` and the ad campaign, round-robin assigned to a counsellor.
(Requires an active **assignment rule** for the tenant, else the lead is created
but unassigned.)

Signature security: the CRM verifies `X-Hub-Signature-256` using the App Secret
you stored — so only genuine Meta calls are accepted.

---

## Part D — Connect OUTBOUND (CRM → Custom Audiences)

On the CRM **Remarketing** page (super_admin/manager):

1. **Connect ad account:** enter the **Ad Account ID** (`act_…` or the number),
   a name, and the **access token** from Part B (needs `ads_management`).
   (`POST /api/v1/remarketing/accounts/connect`.)
2. **Create an audience:** name it, pick the connected ad account, and build a
   segment filter (stage / program / owner / source=Facebook / date range / tags).
3. **Sync to Facebook:** click Sync. The background worker resolves the segment,
   SHA-256-hashes emails/phones (as Meta requires), creates/updates a **Custom
   Audience**, and pushes the users. Status flips `pending → synced`.
4. In **Ads Manager → Audiences** the Custom Audience appears with a member
   count; use it (and Lookalikes from it) to target ads.

---

## Graduation to production (later, only if needed)

Development mode is sufficient while the app touches **only the client's own
Business assets** (added as app roles/assets). You only need **App Review +
Business Verification** if you later onboard *arbitrary third-party* businesses'
Pages that haven't granted access to your app (public self-serve). No code change
— just the Meta review process.

## Troubleshooting
- **Webhook "Verify and Save" fails:** the Verify Token in Meta must exactly
  match `config_json.verify_token`. The CRM `GET /integrations/inbound/:token`
  echoes `hub.challenge` only on an exact match.
- **Lead not appearing:** check the tenant has an active assignment rule; check
  `webhook_events` (raw payloads logged) and the server runtime log for
  `FB lead created` / errors; confirm the Page is subscribed to `leadgen`.
- **Audience sync stuck `pending`:** the ad-account token needs `ads_management`
  and the System User must have **Manage** on that ad account.
