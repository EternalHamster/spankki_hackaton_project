# Google Cloud Run package

This folder is the deployment root for the **UI demo**. One container runs the Node.js web server and a persistent local Python worker with `duckdb==2.0.0`. The worker opens the packaged DuckDB snapshot read-only, caches the three demo customers' chart data and prompt contexts, and exposes eight bounded financial tools over private process pipes. It has no network listener. The separate `../backend/` FastAPI service is not part of this request path.

Key insights and section answers are generated before deployment and packaged in private `server-data/coach-answers.json`. It contains nine actionable insight cards, one weekly, monthly and yearly per customer, spending/saving answers for all 24 recorded months per customer (144 monthly answers), and three weekly answers dated to the snapshot. Startup, page/customer loads and section/month changes read prepared content without model calls. The browser preloads the three default-month topic answers. Spending, saving and transactions have independent month selectors, with transaction category selection preserved; the original Rahavuotesi card remains below the insights.

Every ordinary or follow-up chat remains a live Claude call. It receives the selected customer's compact context and can query that customer's data through the worker. Shared prompt blocks use Anthropic ephemeral prompt caching. No full transaction history is added to each prompt. Restarting restores prepared content from the packaged bundle; it does not generate new text or expire answers after an hour.

Personal preference memory is separate from provider prompt caching. The browser stores at most 12 short notes per selected demo customer and includes only that customer's list in chat requests. The model can propose saving, replacing or forgetting a note with evidence quoted from the latest user message. Validated operations are returned only with a successful final answer and saved after the browser checks the selection and storage revision. Notes are untrusted context, not financial evidence. They are never written to the immutable DuckDB snapshot or shared between demo visitors. They persist across new chats and server restarts in the same browser, but do not sync across devices; users can inspect/delete notes in **Valmentajan muisti**. No new server storage or cloud resource is required.

Deploy from a repository checkout with the Git LFS database available at `../BDA/output/coach.duckdb` and the corresponding tracked synthetic prepared bundle. `deploy/deploy.ps1` packages the database/minimal context code with `scripts/prepare-runtime.mjs`, validates the prepared answers with `scripts/check-prepared.mjs`, and runs Node checks before uploading. Missing or stale content blocks deployment. Source CSVs, the separate FastAPI service and local Python environments are excluded from the upload. No Google Cloud SDK or service-account key is included in the runtime image.

## Chat secret and live deployment

Purchase projects use the same browser-local, customer-scoped persistence as preferences. `coach-projects.mjs` turns a scoped `purchase_plan` calculation into a structured proposal; **Aloita tavoite** or **Päivitä tavoite** confirms it. Other active projects reserve monthly capacity, protected categories are removed before feasibility is calculated, and revisions preserve recorded savings. Project progress is manually recorded and does not imply bank transfers. Changing preference memory marks previous plans for review and hides their stale tips. No new cloud storage resource is needed; include the new public project modules and private `coach-projects.mjs` with the updated worker/BDA code when the queued release is eventually deployed.

The existing service is `oma-talous-ui` in `junctionhackathonspankki`, region `europe-north1`.
`deploy/cloud-run.psd1` binds these Secret Manager versions:

| Environment variable | Secret version | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | `money-coach-anthropic-key:1` | Live server-side Claude chat requests |
| `DEMO_SESSION_SECRET` | `oma-talous-demo-session:1` | Stable signing secret, at least 32 characters |

These secrets are provisioned for the existing project. For another project, provision equivalent secrets securely and allow the runtime identity to read each one:

```powershell
gcloud secrets add-iam-policy-binding money-coach-anthropic-key --project=junctionhackathonspankki --member=serviceAccount:oma-talous-ui@junctionhackathonspankki.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding oma-talous-demo-session --project=junctionhackathonspankki --member=serviceAccount:oma-talous-ui@junctionhackathonspankki.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
.\deploy\deploy.ps1 -ProjectId junctionhackathonspankki -Public
```

The deployment binds secret versions without reading their values locally. Update `ChatSecretVersion` or `SessionSecretVersion` when rotating, then redeploy. Rotating the signing secret invalidates existing demo sessions. Live chat and explicit content preparation incur Anthropic usage charges; deploying or reading prepared content does not call the model.

The browser sends conversation text and optionally an insight ID. The signed HttpOnly cookie selects the customer, and `X-Demo-Selection` binds requests to the current selection. Chat and tool arguments cannot override customer identity or supply arbitrary SQL. Peers appear only as group aggregates. The public selector deliberately permits any visitor to choose one of three synthetic customers; this is not real-user authentication.

The instance allows four simultaneous provider calls and 30 provider calls/minute. Chat has at most four model rounds, six tool calls and 600 / 900 / 1,500 output tokens/round for Selkeä / Perus / Syvällinen answers. A provider call has a 35-second limit within a 75-second overall chat deadline; the browser chat timeout is 90 seconds and Cloud Run's request timeout is 120 seconds. These in-memory controls reset on restart and are not a durable quota.

## 1. Check locally

Install Node.js 24 LTS and Python 3.12+, then open PowerShell in this folder. Use a separate worker environment; do not upgrade the existing parent/backend DuckDB 1.5.6 environment:

```powershell
git lfs pull
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r runtime\requirements.txt
node scripts/check.mjs
.venv\Scripts\python.exe -m unittest discover -s runtime -p test_worker.py -v
node scripts/check-prepared.mjs
node server.mjs
```

Open `http://127.0.0.1:4173/`. Stop the foreground server with Ctrl+C. There are no npm dependencies. Node automatically uses `ui-demos/.venv` when present. A matching bundle supports prepared page content without a provider key. For live chat and content regeneration, configure the provider key in a private environment file:

```powershell
Copy-Item .env.example .env
# Set ANTHROPIC_API_KEY in .env; never commit populated secrets.
node --env-file=.env server.mjs
```

After changing the database, prompt version or model, prepare all three approved synthetic customers before deployment:

```powershell
node --env-file=.env scripts/prepare-coach.mjs --generate
node --env-file=.env scripts/check-prepared.mjs
```

`--generate` is required because this step makes billable Claude calls. It prepares all 24 months of spending/saving answers, the weekly answers and the key insights, then writes the complete bundle to tracked `server-data/coach-answers.json`. Include this synthetic derived file with its corresponding code/data change. Do not commit the private `.env`. Interrupted runs resume compatible progress from ignored `.runtime/prepared-coach-progress.json`; changed database hash, prompt version or model invalidates the checkpoint. The script has no model calls on the deployment path itself: preparation is an explicit, separate step.

`scripts/check-prepared.mjs` requires no API call. It validates the database hash, prompt version, model, customer/month coverage, bullet structure and insight IDs against the current contexts. Both deployment and Docker run it. Stale, missing or incomplete prepared content must be corrected before the service can become ready; there is no runtime regeneration or time-based expiry.

`HOST` defaults to `127.0.0.1`, and `PORT` to `4173` for direct Node runs. Development can use a temporary process-local session secret. Production requires `DEMO_SESSION_SECRET` of at least 32 characters. The container sets `HOST=0.0.0.0` and `PORT=8080`. Cloud Run supplies its own `PORT`; do not put it in Cloud Run environment settings. Optional worker path/version overrides are documented in `.env.example` and [runtime/README.md](./runtime/README.md).

## 2. Test the Docker image (optional)

Install/start Docker Desktop with Linux containers. Populate `ANTHROPIC_API_KEY` and a stable random `DEMO_SESSION_SECRET` of at least 32 characters in private `.env`; Compose passes them to the container. Package the database before building:

```powershell
node scripts/prepare-runtime.mjs
node --env-file=.env scripts/check-prepared.mjs
docker compose up --build -d
docker compose ps
Invoke-RestMethod http://127.0.0.1:8080/readyz
docker compose logs ui
docker compose down
```

Open `http://127.0.0.1:8080/`. Compose binds the host port to localhost, runs with a read-only filesystem and drops Linux capabilities. Set `LOCAL_PORT` in `.env` to change the host port. The image runs as the unprivileged `coach` user and starts Node with an exec-form command; Node manages the private worker. Build verification runs Node checks and validates prepared content against the real packaged database without model calls or provider credentials. The final Debian Bookworm-based image contains Node 24, Python 3.12, DuckDB 2, minimal context code, the private database/recap/prepared-answer bundles and public assets. Rebuild for base-image patches; pin reviewed digests if reproducible image bytes are required.

## 3. Choose cloud settings

Create/select your Google Cloud project, link its billing account or hackathon credits, install the [Google Cloud CLI](https://docs.cloud.google.com/sdk/docs/install-sdk), and sign in:

```powershell
gcloud init
```

Edit `deploy/cloud-run.psd1`, or copy it to the git-ignored `deploy/cloud-run.local.psd1` and pass `-ConfigPath .\deploy\cloud-run.local.psd1`. Defaults:

| Setting | Value |
| --- | --- |
| Service | `oma-talous-ui` |
| Region | `europe-north1` (Finland) |
| CPU / memory | 1 vCPU / 1 GiB |
| Revision instances | 0 minimum / 1 maximum |
| Concurrency / request timeout | 80 / 120 seconds |
| Container port | 8080 |
| Runtime identity | `oma-talous-ui@PROJECT_ID.iam.gserviceaccount.com` |
| Build identity | `oma-talous-ui-build@PROJECT_ID.iam.gserviceaccount.com` |
| Access | Cloud Run IAM authentication; add `-Public` for an open demo |
| Startup / liveness probe | HTTP `/readyz` / `/healthz` |

Scaling to zero reduces idle compute use but adds cold-start latency and discards in-memory customer caches. Before readiness, the worker warms all three customer contexts and bootstrap records, and the server validates/loads the packaged prepared answers without Claude calls. Maximum instances are a scaling setting, not a spending cap; builds, image storage and network use can incur charges. Set a billing budget/alert appropriate to your hackathon credits.

## 4. Preview, then deploy

Replace `YOUR_PROJECT_ID` with the actual project ID. Preview prints commands without contacting Google Cloud or changing anything:

```powershell
.\deploy\deploy.ps1 -ProjectId YOUR_PROJECT_ID -Setup -Plan
```

First deployment, with IAM authentication:

```powershell
.\deploy\deploy.ps1 -ProjectId YOUR_PROJECT_ID -Setup
```

For an intentionally public hackathon demo, use:

```powershell
.\deploy\deploy.ps1 -ProjectId YOUR_PROJECT_ID -Setup -Public
```

Static files in `public/` are downloadable. The database and multi-customer recap/prepared-answer bundles remain outside that root. `/demo-data.json`, `/wrapped-data.json`, `/api/insights`, `/api/summaries` and `/api/chat` require the signed selection and matching nonce. Responses contain only the selected customer's data. `GET /api/summaries` accepts `topic=spending|saving&month=YYYY-MM` or `topic=week`; extra fields, duplicate parameters and customer overrides are rejected. Insight and summary retries only reread prepared content. `PUBLIC_DEMO_CUSTOMER_ID` defaults to `CUST00207` and controls the initial selection; the selector also permits `CUST00127` and `CUST00103`.

`-Setup` enables the Cloud Run, Cloud Build, Artifact Registry and IAM APIs; creates the two identities if missing; and grants only the build identity `roles/run.builder`. It grants no project roles to the runtime identity and does not provision secrets or their access grants. The deploy script prepares `.runtime/`, validates locally, uploads allowlisted UI/runtime sources, and calls `gcloud run deploy --source=.` with the bundled Dockerfile. Cloud Build builds the image, so **local Docker is not required for cloud deployment**. The regional `cloud-run-source-deploy` image repository is created by the source-deployment flow if needed. See Google's [source deployment guide](https://docs.cloud.google.com/run/docs/deploying-source-code).

Subsequent deployments can omit `-Setup`. Include `-Public` each time if you want public access; omitting it requests IAM-protected access and enables the invoker IAM check. The script targets the supplied project explicitly and does not change your CLI's default project.

### Required permissions

For setup, your account needs permission to enable APIs, create service accounts and update project IAM (typically a project owner or an administrator performs this once). For deployment, follow Google's [required deployer roles](https://docs.cloud.google.com/run/docs/deploying-source-code#required_roles): Cloud Run Source Developer, Service Usage Consumer, and Service Account User on the runtime **and custom build** identities. Changing public access requires `run.services.setIamPolicy`, available with Cloud Run Admin. Organization policies can forbid public access or custom service accounts.

If you do not have owner permissions, ask your project administrator to perform `-Setup` and grant the deployer roles. IAM changes can take a few minutes to propagate; if the first build fails immediately after setup, wait and retry without `-Setup`. No downloaded JSON service-account keys or Application Default Credentials login are needed for this UI deployment.

## 5. Open and verify

The script prints the service URL when deployment finishes. For a public service:

```powershell
Invoke-RestMethod https://YOUR_SERVICE_URL/readyz
```

For an IAM-protected service, use a local authenticated proxy, then open `http://127.0.0.1:8080/`:

```powershell
gcloud run services proxy oma-talous-ui --project YOUR_PROJECT_ID --region europe-north1 --port 8080
```

Your account needs Cloud Run Invoker access for the protected service. Select each demo customer and confirm charts, prepared insights and the default-month topic answers load. Expand each topic, change spending/saving months independently, and change transaction month while keeping its category. Those checks make no model calls. Click a card or use a topic follow-up, ask an ordinary chat question about a dated spending period, then switch customers and confirm the old conversation/cards clear; these live chat checks are billable. Inspect the rings, Menohistoria, savings slider and the original Rahavuotesi card below the insights. The standalone analytics example is at `/finance-analytics/example.html`.

View logs:

```powershell
gcloud run services logs read oma-talous-ui --project YOUR_PROJECT_ID --region europe-north1 --limit 50
```

Cloud Run provides HTTPS and request logs. Startup/error/shutdown messages are JSON on stdout. `/healthz` checks the process; `/readyz` checks the worker, validated prepared answers, private recap bundle and core UI assets. Health checks never call Claude. Provider usage logs record input/output/cache token counts without logging financial prompts. Cloud Run probes are configured explicitly because Docker HEALTHCHECK alone does not configure Cloud Run health checks. See the [container contract](https://docs.cloud.google.com/run/docs/container-contract) and [health-check guide](https://docs.cloud.google.com/run/docs/configuring/healthchecks).

## 6. Update, roll back or stop

Redeploy with the same command after editing. Regenerate and validate prepared content first when the database, prompts or model change. A code-only or visual change that leaves those inputs intact can reuse the matching bundle. To roll back, find the previous revision and send traffic to it:

```powershell
gcloud run revisions list --service oma-talous-ui --project YOUR_PROJECT_ID --region europe-north1
gcloud run services update-traffic oma-talous-ui --to-revisions PREVIOUS_REVISION=100 --project YOUR_PROJECT_ID --region europe-north1
```

To remove this service when the demo ends:

```powershell
gcloud run services delete oma-talous-ui --project YOUR_PROJECT_ID --region europe-north1
```

Deletion of the service does not delete stored images/build artifacts or the service accounts. Review Artifact Registry and Cloud Build storage separately; the source-deploy repository may also contain images belonging to other services.

## Before connecting real customers

`public/adapters/project-finance.js` maps the selected customer's data to the analytics contract in `INTEGRATION.md`. The current signed session protects demo selection and rejects stale responses, but does not establish who a person is. Replace public persona selection with authenticated user sessions and map each identity to its permitted customer on the server for every data, insight, summary, recap and chat endpoint. Preserve worker scoping and group-only peer comparisons. The Content Security Policy permits same-origin scripts and API calls; a future cross-origin API needs corresponding CSP and backend CORS changes.
