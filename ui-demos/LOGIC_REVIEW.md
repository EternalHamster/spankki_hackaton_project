# UI logic review

Reviewed on 14 November 2026 against the prepared synthetic dataset and existing analytics tests.

## Findings addressed

1. **Cloud Run reachability:** the original server bound only to loopback. The image now binds to `0.0.0.0` and respects Cloud Run's `PORT`. Direct local runs retain localhost defaults.
2. **Filesystem writes on startup:** removed the `server.pid` write. The container can run unprivileged with a read-only filesystem.
3. **Balance ordering:** monthly summaries now order transactions by recorded date/time before choosing each account's final balance and the latest transaction date. Unordered API results no longer change balances or the recent-transaction list.
4. **Money accumulation:** summaries and baskets now accumulate integer cents, as the analytics module already did. Percentage scenarios retain fractional cents until display rounding.
5. **Malformed clock values:** daily history accepts only `HH:mm:ss` within valid ranges. Invalid/missing clock values are retained in the unknown-time bucket.
6. **Deployment messages and script policy:** removed the UI's unconditional claim that nothing has been published to the cloud. Moved the isolated example's inline JavaScript into its own module and made reload use the app's normal event handler so both work with a same-origin script policy.
7. **HTTP behavior:** added GET/HEAD semantics, explicit rejection of unsupported methods, file-type handling, public-root and symlink containment, hidden-path protection, health/readiness routes, structured lifecycle logs and graceful shutdown.
8. **Shared classification:** summary cards and charts now use one transaction-kind helper. Consumer refunds and negative income reversals are excluded from spending/income charts and retained as other account movements in the cash-flow detail, so totals reconcile consistently.

## Logic verified

- Exact September source totals and the salary-sweep example.
- Spending/income charts reconcile with summary metrics across every profile/month in the sample.
- Baskets reconcile with spending, including category reassignment.
- Income minus everyday spending and the investment/sweep movements reconcile with total net flow for the prepared data.
- Annual comparisons use common complete calendar months, not nine months versus twelve.
- Covered zero-spending days differ from unavailable days. Leap days, Monday–Sunday weeks and previous-month day alignment preserve source totals.
- Weekday/weekend calculations count calendar days and exclude transfers.
- HTTP serves all required assets and blocks source/configuration paths. Incomplete packages fail readiness.
- Docker builds run the same syntax/calculation/HTTP suite before assembling the runtime image.

## Validation performed

All 22 syntax/calculation/HTTP tests passed locally on Node 24.22.1. A headless Edge check exercised all three visible customers across three months each, income/spending selection, annual month selection, all five history views, transaction dialogs, the savings slider, chat drafts and the isolated module's update/destroy/remount flow. Mobile and desktop screenshots were inspected; the browser reported no script, CSP or resource errors. The actual Google Cloud CLI upload list was checked against the allowlist, and both public/private deployment plans were reviewed without deploying.

Docker is unavailable on the preparation machine, so the Docker image has not been built or run here. No Google Cloud build or deployment has been performed. Run the Docker commands or cloud deployment in `DEPLOYMENT.md` to validate those environments.

## Scope and integration limits

This is a synthetic-data frontend demonstration. Its selectors do not authorize access, its savings scenarios do not predict future balances, and its chat does not send questions. There is no bank connection or production identity system. Account balances are the last recorded balance per account, not real-time balances.

The shared classification treats positive consumer refunds and negative income reversals as other account movements, not earnings or negative purchases. This policy preserves gross spending/income views and separately reconciles net flow. Confirm this policy with the intended source before connecting a real banking API; current tests do not establish correctness for an arbitrary bank API.

The package contains the already prepared sample JSON. `scripts/prepare-data.mjs` is optional and requires the original sibling `Data/` CSV directory, which is excluded from cloud uploads and the standalone release archive.
