# Invoice Collector — Google Apps Script

Automatically pulls email attachments tagged with a Gmail label, classifies them via Gemini, and files invoices into Google Drive under a `YYYY/YYYY-MM` folder structure. Receipts and unknowns are skipped. Processed threads are archived.

---

## How it works

1. Gmail is scanned for **inbox** threads with your chosen label (default: `invoices`). Archive state is the sole deduplication mechanism — already-archived threads are never re-processed.
2. PDF attachments are sent to **Gemini 2.5 Flash** for classification:
   - Returns document type (`invoice` | `receipt` | `unknown`) + the date printed on the document.
   - Receipts and unknowns are skipped — not saved to Drive.
   - If Gemini can't extract a date, the thread's email date is used as fallback.
3. Non-PDF attachments (images, spreadsheets) skip classification and use the thread date directly.
4. Files are saved to `<root>/<YYYY>/<YYYY-MM>/` based on the document date.
5. The thread is **archived** (removed from inbox).
6. On error, the thread is left in the inbox and retried on the next run.

## Modules

| File | Responsibility |
|---|---|
| `utils.ts` | Shared `withRetry` helper, `buildQueryString` utility |
| `config.ts` | All settings via `ScriptProperties` / `UserProperties` |
| `auth.ts` | Service account JWT minting, token exchange, caching |
| `gemini.ts` | PDF classification via Gemini 2.5 Flash REST API |
| `drive.ts` | Drive REST API — folder resolution and file upload |
| `gmail.ts` | Gmail REST API — scanning, attachments, archiving |
| `main.ts` | Public entry points, trigger management |

---

## Prerequisites

### Node.js

Required: **Node.js 18 or later**.

```bash
node -v   # should print v18.x.x or higher
```

If not installed, use [nvm](https://github.com/nvm-sh/nvm) (recommended) or download from [nodejs.org](https://nodejs.org):

```bash
# via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
nvm use 20
```

### GitLab CLI (`glab`) — only needed for CI token management

```bash
# macOS
brew install glab

# Linux
curl -s https://raw.githubusercontent.com/cli/go-cli/main/scripts/install_linux.sh | bash
# or via snap:
sudo snap install glab

# Authenticate
glab auth login
```

---

## Installation

### Part 1 — Google Cloud setup (one-time)

#### 1. Create a GCP project

Go to [https://console.cloud.google.com](https://console.cloud.google.com) → **New Project** → name it `invoice-collector` (or anything you like). Note the **Project ID**.

#### 2. Enable required APIs

In the GCP console, go to **APIs & Services → Library** and enable:
- **Gmail API**
- **Google Drive API**

#### 3. Create a service account

Go to **IAM & Admin → Service Accounts → Create Service Account**:
- Name: `invoice-collector`
- Description: `Invoice collector script runtime`
- Click **Create and Continue**
- Skip role assignment — the service account needs no GCP IAM roles (it accesses Gmail/Drive via delegation, not GCP resources)
- Click **Done**

#### 4. Create and download a JSON key

Click the newly created service account → **Keys** tab → **Add Key → Create new key → JSON**.

A `.json` file downloads. **This is the service account key.** Keep it secret — never commit it.

Copy its contents — you'll need the full JSON string when running `setupConfig()`.

#### 5. Grant domain-wide delegation in Workspace Admin

Go to [https://admin.google.com](https://admin.google.com) → **Security → Access and data control → API controls → Manage Domain Wide Delegation → Add new**.

Fill in:
- **Client ID**: the `client_id` field from your service account JSON key (a long number)
- **OAuth scopes** (comma-separated):
  ```
  https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/drive
  ```

Click **Authorize**. It may take a few minutes to propagate.

> This is the step that allows the service account to act as a real user in your domain. Without it, all API calls will return 403.

#### 6. Share the Drive folder with the service account

Create a folder in Google Drive where invoices should land (e.g. `Invoices`). Right-click → **Share** → add the service account's email address (it looks like `invoice-collector@your-project.iam.gserviceaccount.com`) with **Editor** access.

Copy the folder ID from the URL:
```
https://drive.google.com/drive/folders/THIS_PART_IS_THE_ID
```

---

### Part 2 — Apps Script setup

#### 7. Install dependencies and log in

```bash
git clone <your-repo-url>
cd invoice-collector
npm install
npx clasp login
```

This installs:
- `@google/clasp` — CLI to push/pull Apps Script projects
- `@types/google-apps-script` — TypeScript type definitions for GWS APIs
- `typescript` — the compiler

`npx clasp login` opens a browser OAuth window. Log in with **your Workspace account** (not the service account — that's not a human-login account).

#### 8. Create the Apps Script project

```bash
npx clasp create --type standalone --title "Invoice Collector"
```

Creates an empty Apps Script project and writes its ID into `.clasp.json`. Do not commit `.clasp.json` if the repo is public — it exposes your script ID.

#### 9. Get a Gemini API key

Go to [https://aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) and create an API key. Free tier, no credit card required.

#### 10. Push the code

```bash
npm run push
```

Compiles TypeScript and uploads all modules. The script now makes **no OAuth prompts** at runtime — all Gmail/Drive access goes through the service account.

#### 11. Create your Gmail label

In Gmail (as your Workspace user), create a label `invoices` and tag incoming invoice emails with it.

#### 12. Configure the script

```bash
npx clasp open
```

In the Apps Script editor console, call `setupConfig` once:

```js
setupConfig(
  "YOUR_DRIVE_FOLDER_ID",
  "YOUR_GEMINI_API_KEY",
  JSON.stringify(/* paste your service account JSON key object here */),
  "your.name@yourdomain.com",  // the Workspace user whose Gmail/Drive to access
  "invoices"                   // Gmail label to scan (default: "invoices")
);
```

The service account key JSON contains newlines in the private key — use `JSON.stringify()` to pass it as a single string, or paste the entire contents as a string literal.

`printConfig()` will confirm everything is stored (the key itself is redacted in the output).

#### 13. Install the hourly trigger

```js
installTrigger();
```

Verify it appeared under **Triggers** (clock icon in the left sidebar).

#### 14. Verify with a manual run

```js
runManually();
```

Check **Executions** (left sidebar). A successful first run will show threads found, PDFs classified, files saved, and threads archived.

---

## Folder structure

```
<root folder>/
  2024/
    2024-11/
      invoice_acme.pdf         ← date from Gemini: 2024-11-03
    2024-12/
      facture_hosting.pdf      ← date from Gemini: 2024-12-01
  2025/
    2025-01/
      rechnung_aws.pdf         ← date from Gemini: 2025-01-15
```

Receipts and unknowns are silently skipped and logged.

---

## Manual operations

| Function | What it does |
|---|---|
| `runManually()` | One-shot run, logs full result |
| `setupConfig(folderId, geminiKey, saKey, email, label)` | Save/update config |
| `installTrigger()` | Install/reset hourly trigger |
| `removeTriggers()` | Remove all triggers |
| `printConfig()` | Log current settings |
| `clearTokenCache()` | Clear cached access tokens (run after updating delegation scopes) |

---

## CI/CD deployment

The deploy job compiles and pushes via clasp. It takes ~30 seconds — well within free tier limits on both platforms.

Two secrets are involved:
- `CLASP_TOKEN` — your personal Workspace OAuth token. Gives write access to the Apps Script project only. Used by clasp during CI push.
- `SA_KEY` — the service account JSON key. Used at **runtime** by the script itself. Not used during CI — it's stored in the script via `setupConfig()`, not in the workflow.

### GitLab CI

**Free tier:** unlimited minutes on Linux runners for private repos (GitLab.com Free plan includes 400 minutes/month on shared runners; this job uses ~0.5 minutes per push).

#### First-time setup

After running `npx clasp login` locally, store the token as a masked CI variable:

```bash
# via glab CLI
glab variable set CLASP_TOKEN \
  --value "$(cat ~/.clasprc.json)" \
  --masked \
  --project <your-project-path>

# or via curl
curl --request POST \
  --header "PRIVATE-TOKEN: <your_gitlab_pat>" \
  --form "key=CLASP_TOKEN" \
  --form "value=$(cat ~/.clasprc.json)" \
  --form "masked=true" \
  "https://gitlab.com/api/v4/projects/<project_id>/variables"
```

#### `.gitlab-ci.yml`

```yaml
deploy:
  image: node:20-alpine
  stage: deploy
  only:
    - main
  script:
    - npm ci
    - echo "$CLASP_TOKEN" > ~/.clasprc.json
    - npx clasp push --force
```

#### Refreshing an expired token

```bash
npx clasp login   # re-authenticates, overwrites ~/.clasprc.json

glab variable update CLASP_TOKEN \
  --value "$(cat ~/.clasprc.json)" \
  --masked \
  --project <your-project-path>
```

---

### GitHub Actions

**Free tier:** 2,000 minutes/month on Linux runners for private repos (GitHub Free plan). Public repos get unlimited free minutes. This job uses ~0.5 minutes per push, so the free quota covers ~4,000 deployments/month on a private repo — effectively unlimited for this use case.

#### First-time setup

Store the clasp token as a repository secret:

```bash
# via GitHub CLI (gh)
gh secret set CLASP_TOKEN \
  --body "$(cat ~/.clasprc.json)" \
  --repo <owner>/<repo>

# or via curl
curl --request PUT \
  --header "Authorization: Bearer <your_github_pat>" \
  --header "Content-Type: application/json" \
  --data "{\"encrypted_value\": \"$(cat ~/.clasprc.json | base64)\"}" \
  "https://api.github.com/repos/<owner>/<repo>/actions/secrets/CLASP_TOKEN"
```

Note: the curl approach requires encrypting the secret with the repo's public key first — the `gh` CLI handles this automatically and is strongly recommended.

Install `gh` if you don't have it:

```bash
# macOS
brew install gh

# Linux
sudo apt install gh   # Debian/Ubuntu
# or
sudo dnf install gh   # Fedora

gh auth login
```

#### `.github/workflows/deploy.yml`

```yaml
name: Deploy to Apps Script

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Authenticate clasp
        run: echo "$CLASP_TOKEN" > ~/.clasprc.json
        env:
          CLASP_TOKEN: ${{ secrets.CLASP_TOKEN }}

      - name: Push to Apps Script
        run: npx clasp push --force
```

#### Refreshing an expired token

```bash
npx clasp login   # re-authenticates, overwrites ~/.clasprc.json

gh secret set CLASP_TOKEN \
  --body "$(cat ~/.clasprc.json)" \
  --repo <owner>/<repo>
```

---

## Security

### The threat model

**Runtime credentials (service account key):** The service account JSON key stored in CI has Gmail modify and Drive write scopes on your Workspace domain — scoped only to the APIs explicitly granted during domain-wide delegation setup. If it leaks, an attacker can read your Gmail label and write to your Drive folder, but cannot access the rest of your Google account. The key does not expire on its own but can be revoked instantly in the GCP console without affecting your personal account.

**Deploy credentials (clasp token):** The clasp token gives write access to the Apps Script project only — it cannot read Gmail or Drive. If it leaks, an attacker can replace the script code, which is serious but recoverable (re-push from the repo, revoke the token). It has no access to your data directly.

This is a significant improvement over the previous architecture where a single personal OAuth token covered everything.

The realistic attack vector is **supply chain**: a compromised npm package or a hijacked GitHub Action that prints environment variables or exfiltrates secrets over the network during the build.

### Mitigations

#### 1. Pin GitHub Actions to full commit SHAs

Tags like `actions/checkout@v4` are mutable — a maintainer (or attacker who compromises the maintainer) can point the tag at malicious code at any time. SHA pins are immutable.

Replace tags with SHAs in `.github/workflows/deploy.yml`:

```yaml
steps:
  - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683        # v4.2.2
  - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af      # v4.1.0
```

To find the SHA for any Action: go to the Action's GitHub page → Releases → click the tag → copy the full commit SHA from the URL or the commit list.

Automate this with [Dependabot](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot) — add to `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

Dependabot will open PRs to update pinned SHAs automatically when new versions are released.

#### 2. Lock npm dependencies

`npm ci` already installs from `package-lock.json` exactly, but the lock file only pins versions — not content. A package can be republished at the same version with different code (rare but has happened).

Enable npm provenance checks and use `npm audit` in CI:

```yaml
- name: Audit dependencies
  run: npm audit --audit-level=high
```

For stronger guarantees, consider migrating to a lock file with content hashing. `package-lock.json` v3 (npm 7+) includes `integrity` SHA-512 hashes for every package — `npm ci` verifies these automatically. Make sure `package-lock.json` is committed and never in `.gitignore`.

#### 3. Restrict the workflow's secret access

Add explicit permissions to the workflow so the token is scoped as tightly as possible:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read   # checkout only, no write access to the repo
    env:
      CLASP_TOKEN: ${{ secrets.CLASP_TOKEN }}
```

This prevents the workflow from writing back to the repo even if compromised.

#### 4. Protect the main branch

In **Settings → Branches → Branch protection rules** for `main`:

- Enable **Require pull request reviews before merging** (even for a solo repo, this forces changes through a reviewable PR rather than a direct push)
- Enable **Do not allow bypassing the above settings**

In **Settings → General → Features**:

- Disable **Allow forking** — prevents anyone from forking the repo and opening PRs that trigger workflows with access to your secrets

#### 5. Limit the OAuth token scope (longer term)

The clasp token currently grants access to all Google services the user has ever authorized. The proper long-term fix is a **Google Cloud service account** with only the scopes this script uses (`gmail.modify`, `drive`, `script.projects`). Service accounts can be scoped precisely, rotated programmatically, and revoked without affecting your personal account.

This is meaningful setup overhead and is documented in the [Google Cloud service account docs](https://cloud.google.com/iam/docs/service-account-overview) if you decide to invest in it later.

#### Practical summary

| Measure | Effort | Status | Impact |
|---|---|---|---|
| Service account + domain-wide delegation | Done | ✅ | Eliminates personal account exposure |
| Pin Actions to SHA | Done | ✅ | Eliminates hijacked Action risk |
| `npm audit` in CI | Done | ✅ | Catches known vulnerable packages |
| Branch protection + no forks | Manual | Recommended | Prevents external workflow triggers |
| Workflow `permissions: contents: read` | Done | ✅ | Limits blast radius |
| Dependabot for Actions | Done | ✅ | Keeps SHA pins current automatically |

---

## Notes

- Gemini 2.5 Flash free tier: 15 requests/minute, 1,500/day. At hourly runs with typical invoice volumes this is nowhere near the limit.
- `temperature: 0` and `responseMimeType: "application/json"` are set on the Gemini call — deterministic classification with structured JSON output.
- The Gemini 2.5 response parser handles "thinking" model output by filtering out internal reasoning parts and extracting only the final JSON.
- All config (folder ID, API key, labels) is stored in `UserProperties` — never in code or the repo.
- Access tokens are cached per scope — Gmail and Drive tokens are stored separately to avoid scope mismatch errors.
- Each thread's error is isolated — one bad PDF won't abort the batch, and failed threads stay in inbox for retry.
- Folder creation is idempotent — existing folders are reused, never duplicated.
