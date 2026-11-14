# Google Cloud Run package

This folder is the complete deployment root for the **UI demo**. It serves the prepared synthetic samples and reusable analytics module. The same Node service also handles text-only Claude chat at `POST /api/chat`. The separate `../backend/` Python coach and project data are not used by chat. The server requires `ANTHROPIC_API_KEY`, injected from Secret Manager; no key is sent to the browser. No database, Google Cloud SDK, service-account key or source CSV is needed at runtime.

The standalone release ZIP contains this deployment folder, documentation and tests. It excludes source CSVs, the Python backend, old UI archives and local validation artifacts. Extract it and run the commands below inside the extracted `oma-talous-ui/` directory.

## Chat secret and live deployment

The existing service is `oma-talous-ui` in `junctionhackathonspankki`, region `europe-north1`.
`deploy/cloud-run.psd1` references `money-coach-anthropic-key`, numeric version `1`.
Before the first chat deployment, allow the UI runtime identity to read this specific secret:

```powershell
gcloud secrets add-iam-policy-binding money-coach-anthropic-key --project=junctionhackathonspankki --member=serviceAccount:oma-talous-ui@junctionhackathonspankki.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
.\deploy\deploy.ps1 -ProjectId junctionhackathonspankki -Public
```

This reuses the existing secret without reading its value locally. The deploy script preserves other
environment settings and binds the selected secret version. Future key rotations should update
`ChatSecretVersion` before redeploying. Model calls incur Anthropic usage charges.

The UI sends only text conversation, never project data. The Node endpoint limits input/history,
allows four simultaneous calls and 30 requests/minute per instance, and bounds each reply to 800 tokens.
These in-memory limits reset on restart and are not a durable quota. Requests time out after 35 seconds.
The site remains a public hackathon demo. Customer-data integration will require authentication.

## 1. Check locally

Install Node.js 24 LTS, then open PowerShell in this folder:

```powershell
node scripts/check.mjs
node server.mjs
```

Open `http://127.0.0.1:4173/`. Stop the foreground server with Ctrl+C. There are no npm dependencies to install. Optional local environment file:

```powershell
Copy-Item .env.example .env
node --env-file=.env server.mjs
```

`HOST` defaults to `127.0.0.1`, and `PORT` to `4173` for direct Node runs. The container sets `HOST=0.0.0.0` and `PORT=8080`. Cloud Run supplies its own `PORT`; do not put that variable in Cloud Run environment settings.

## 2. Test the Docker image (optional)

Install/start Docker Desktop with Linux containers:

```powershell
docker compose up --build -d
docker compose ps
Invoke-RestMethod http://127.0.0.1:8080/readyz
docker compose logs ui
docker compose down
```

Open `http://127.0.0.1:8080/`. Compose binds the host port to localhost, runs the image with a read-only filesystem and drops Linux capabilities. Set `LOCAL_PORT` in `.env` to change the host port. The image runs as the unprivileged `node` user, uses an exec-form Node command, handles SIGTERM, and needs no writable files. Its first Docker stage runs syntax and integration tests; the final image contains only the server, package metadata and `public/` assets. The Node 24 Alpine base tag receives updates, so rebuild for patches; pin a reviewed digest if reproducible base-image bytes are required.

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
| CPU / memory | 1 vCPU / 256 MiB |
| Revision instances | 0 minimum / 2 maximum |
| Concurrency / request timeout | 80 / 60 seconds |
| Container port | 8080 |
| Runtime identity | `oma-talous-ui@PROJECT_ID.iam.gserviceaccount.com` |
| Build identity | `oma-talous-ui-build@PROJECT_ID.iam.gserviceaccount.com` |
| Access | Cloud Run IAM authentication; add `-Public` for an open demo |
| Startup / liveness probe | HTTP `/readyz` / `/healthz` |

Scaling to zero reduces idle compute use. Maximum instances are a scaling setting, not a spending cap; builds, image storage and network use can incur charges. Set a billing budget/alert appropriate to your hackathon credits.

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

All files in `public/`, including all four prepared sample profiles, are downloadable by anyone who can access the service. The customer selector only controls the display. This is appropriate for these synthetic samples; it is not customer authorization.

`-Setup` enables the Cloud Run, Cloud Build, Artifact Registry and IAM APIs; creates the two identities if missing; and grants only the build identity `roles/run.builder`. It grants no project roles to the runtime identity. The deploy script validates locally, uploads only the allowlisted UI sources, and calls `gcloud run deploy --source=.` with the bundled Dockerfile. Cloud Build builds the image, so **local Docker is not required for cloud deployment**. The regional `cloud-run-source-deploy` image repository is created by the source-deployment flow if needed. See Google's [source deployment guide](https://docs.cloud.google.com/run/docs/deploying-source-code).

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

Your account needs Cloud Run Invoker access for the protected service. In the UI, switch customers/months, inspect the income/spending rings, open Menohistoria, move the period slider, open transactions and try the savings slider. The standalone analytics example is at `/finance-analytics/example.html`.

View logs:

```powershell
gcloud run services logs read oma-talous-ui --project YOUR_PROJECT_ID --region europe-north1 --limit 50
```

Cloud Run provides HTTPS and request logs. Startup/error/shutdown messages are JSON on stdout. `/healthz` checks the process; `/readyz` checks that every core UI runtime asset exists. Cloud Run probes are configured explicitly because Docker HEALTHCHECK alone does not configure Cloud Run health checks. See the [container contract](https://docs.cloud.google.com/run/docs/container-contract) and [health-check guide](https://docs.cloud.google.com/run/docs/configuring/healthchecks).

## 6. Update, roll back or stop

Redeploy with the same command after editing. To roll back, find the previous revision and send traffic to it:

```powershell
gcloud run revisions list --service oma-talous-ui --project YOUR_PROJECT_ID --region europe-north1
gcloud run services update-traffic oma-talous-ui --to-revisions PREVIOUS_REVISION=100 --project YOUR_PROJECT_ID --region europe-north1
```

To remove this service when the demo ends:

```powershell
gcloud run services delete oma-talous-ui --project YOUR_PROJECT_ID --region europe-north1
```

Deletion of the service does not delete stored images/build artifacts or the service accounts. Review Artifact Registry and Cloud Build storage separately; the source-deploy repository may also contain images belonging to other services.

## Future coach/backend integration

`public/adapters/project-finance.js` maps the sample data to the analytics contract documented in `INTEGRATION.md`. Keep identity verification and customer scoping in the backend. Before connecting chat to customer data, add authenticated user sessions and customer-scoped API access. The current chat is text-only and already handles loading/errors with a server-side provider key. The current Content Security Policy allows same-origin scripts and API calls; an intentional cross-origin API would require matching `connect-src` and backend CORS changes. The separate Python backend also needs its database snapshot, model-provider configuration and authentication configuration; the UI container does not supply those.
