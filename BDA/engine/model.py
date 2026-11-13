"""Hierarchical empirical-Bayes spending model.

Structure:  Statistics Finland  ->  peer group (age band x area)  ->  customer  ->  transactions

1. Spending lines (everyday, shocks, big purchases): compound "frequency x size" model
       N_it   ~ Poisson(lambda_i)              transactions per month
       lambda_i ~ Gamma(a_gk, b_gk)              peer-group prior          -> conjugate Gamma posterior
       xbar_i ~ Normal(m_i, cv_k^2 M^2 / n_i)  average € per transaction (constant coefficient of variation)
       m_i    ~ Normal(M_gk, t_k^2 M_gk^2)      peer-group prior          -> conjugate Normal posterior
       log M_gk ~ Normal(log M0_gk, STATFIN_PRIOR_SD^2)  Statistics Finland prior on the peer-group level
   expected monthly spend  E_i = lambda_i * m_i
   (Sizes are modelled on the € scale on purpose: a log-normal size model over-estimated the mean by
    ~10 % on lines where the largest 5 % of payments are split off as shocks / big purchases.)

2. Income, rent, utilities, savings transfers: normal-normal model on monthly totals, shrunk to the
   peer group (income with a Statistics Finland prior on the peer-group mean).

3. Derived: peer comparison, trend (recent 6 months vs earlier, posterior probability of a real change),
   safe-to-spend (Monte Carlo until next payday), surprise fund.

Hyperparameters are estimated from all customers (method of moments). Everything per customer is
closed form, so scoring one customer takes milliseconds and a full run takes seconds.
"""
import time
import numpy as np
import pandas as pd
import duckdb

from . import config as C
from .statfin import load_priors

DPM = 30.44  # days per month
COMPOUND_LINES = C.EVERYDAY_LINES + C.EVENT_LINES
MONTHLY_LINES = ["income", "housing", "utilities", "savings_transfer"]


# ------------------------------------------------------------------ data access
def month_index(con):
    return pd.to_datetime(con.sql("select distinct month from transactions order by 1").df()["month"]).tolist()


def suff_stats(con, start, end, lines=COMPOUND_LINES):
    """Sufficient statistics per customer x line for months in [start, end] (inclusive, as dates)."""
    in_lines = "(" + ",".join(f"'{l}'" for l in lines) + ")"
    df = con.sql(f"""
        with s as (
          select customer_id, line, count(*) n, sum(ln(spend)) slx, sum(ln(spend)^2) sslx, sum(spend) eur, sum(spend^2) sx2
          from transactions
          where line in {in_lines} and spend > 0 and month between '{start:%Y-%m-%d}' and '{end:%Y-%m-%d}'
          group by all)
        select c.customer_id, c.peer_group, c.age_band, l.line,
               coalesce(s.n, 0) n, coalesce(s.slx, 0) slx, coalesce(s.sslx, 0) sslx, coalesce(s.eur, 0) eur, coalesce(s.sx2, 0) sx2
        from customers c cross join (select unnest({list(lines)}) line) l
        left join s using (customer_id, line)""").df()
    df["T"] = (end.year - start.year) * 12 + end.month - start.month + 1
    return df


def monthly_totals(con, lines=MONTHLY_LINES):
    in_lines = "(" + ",".join(f"'{l}'" for l in lines) + ")"
    return con.sql(f"""
        select m.customer_id, c.peer_group, c.age_band, m.line, m.month, m.amount
        from customer_month_line m join customers c using (customer_id)
        where m.line in {in_lines}""").df()


# ------------------------------------------------------------------ compound model
def fit_compound(st, statfin_spend):
    """Peer-group hyperparameters per line. Returns one row per (peer_group, line)."""
    st = st.copy()
    st["r"] = st["n"] / st["T"]

    # ---- frequency: Gamma prior by method of moments on the rates (negative-binomial moments)
    freq = (st.groupby(["peer_group", "age_band", "line"])
              .agg(m=("r", "mean"), v=("r", "var"), T=("T", "first"), n_cust=("r", "size")).reset_index())
    excess = freq["v"] - freq["m"] / freq["T"]
    freq["a"] = np.where(excess > 1e-9, freq["m"] ** 2 / excess.clip(lower=1e-9), 1e4).clip(0.05, 1e4)
    freq["b"] = freq["a"] / freq["m"].clip(lower=1e-6)

    # ---- size: mean € per transaction, variance proportional to size^2 (constant CV)
    used = st[st["n"] > 0].copy()
    used["xbar"] = used["eur"] / used["n"]
    used["ss_rel"] = (used["sx2"] - used["n"] * used["xbar"] ** 2) / used["xbar"] ** 2
    cv2 = (used.groupby("line")["ss_rel"].sum() / (used["n"] - 1).groupby(used["line"]).sum()).rename("cv2")
    # log-scale spread, only used for the shape of simulated single payments
    used["zbar"] = used["slx"] / used["n"]
    sig2 = ((used["sslx"] - used["n"] * used["zbar"] ** 2).groupby(used["line"]).sum()
            / (used["n"] - 1).groupby(used["line"]).sum()).rename("sigma2")

    used = used.merge(cv2, on="line")
    gm = used.groupby(["peer_group", "line"])["xbar"].transform("mean")
    used["noise_rel"] = used["cv2"] / used["n"]                         # var(xbar)/M^2
    gs = used.assign(xrel=used["xbar"] / gm).groupby(["peer_group", "line"]).agg(
        xrel_var=("xrel", "var"), noise=("noise_rel", "mean"), k=("xrel", "size")).reset_index()
    gs["t2_g"] = (gs["xrel_var"] - gs["noise"]).clip(lower=0.02 ** 2)
    t2rel = ((gs["t2_g"] * gs["k"]).groupby(gs["line"]).sum() / gs["k"].groupby(gs["line"]).sum()).rename("t2rel")
    used = used.merge(t2rel, on="line")
    used["w"] = 1.0 / (used["t2rel"] + used["noise_rel"])              # relative precision
    md = (used.assign(wx=used["w"] * used["xbar"]).groupby(["peer_group", "line"])
              .agg(sw=("w", "sum"), swx=("wx", "sum")).reset_index())
    md["M_data"] = md["swx"] / md["sw"]

    h = freq.merge(md[["peer_group", "line", "sw", "M_data"]], on=["peer_group", "line"], how="left")
    h = h.merge(cv2, on="line").merge(t2rel, on="line").merge(sig2, on="line")
    h = h.merge(statfin_spend.rename(columns={"eur_month": "statfin_eur"}), on=["age_band", "line"], how="left")

    # ---- Statistics Finland prior on the peer-group mean size:  E_g = m_g * M_g  =>  M0 = statfin / m_g
    # prior sd = STATFIN_PRIOR_SD * M0; data precision (relative) = sw
    ok = (h["statfin_eur"] > 0) & (h["m"] > 0)
    h["M0"] = np.where(ok, h["statfin_eur"] / h["m"].where(ok, 1), np.nan)
    p0 = np.where(ok, 1.0 / C.STATFIN_PRIOR_SD ** 2, 0.0)
    sw = h["sw"].fillna(0.0)
    # combine on the log scale so both sides are relative: log M ~ N(log M0, sd^2), data ~ N(log M_data, 1/sw)
    logM = np.where(sw > 0, (p0 * np.log(h["M0"].fillna(1)) + sw * np.log(h["M_data"].fillna(1))) / (p0 + sw),
                    np.log(h["M0"].fillna(h.groupby("line")["M_data"].transform("mean"))))
    h["M"] = np.exp(logM)
    h["statfin_weight"] = np.where(sw > 0, p0 / (p0 + sw), 1.0 * ok)
    h["T2"] = h["t2rel"] * h["M"] ** 2
    return h[["peer_group", "age_band", "line", "n_cust", "a", "b", "M", "T2", "cv2", "sigma2",
              "M_data", "statfin_eur", "statfin_weight"]]


def posterior_compound(st, hyper):
    """Closed-form per-customer posteriors. Adds rate, size, expected monthly spend."""
    d = st.merge(hyper[["peer_group", "line", "a", "b", "M", "T2", "cv2", "sigma2"]], on=["peer_group", "line"])
    d["shape"] = d["a"] + d["n"]
    d["rate_"] = d["b"] + d["T"]
    d["lam"] = d["shape"] / d["rate_"]                       # transactions per month
    xbar = np.where(d["n"] > 0, d["eur"] / d["n"].clip(lower=1), 0.0)
    data_prec = np.where(d["n"] > 0, d["n"] / (d["cv2"] * d["M"] ** 2), 0.0)
    prec = 1.0 / d["T2"] + data_prec
    d["size_eur"] = (d["M"] / d["T2"] + data_prec * xbar) / prec   # € per transaction
    d["size_var"] = 1.0 / prec
    d["expected_month"] = d["lam"] * d["size_eur"]
    d["raw_month"] = d["eur"] / d["T"]
    return d


TREND_PRIOR_MONTHS = 2.0


def window_posterior(st, own):
    """Posterior for one time window with the customer's own long-run level as a weak prior."""
    d = st.merge(own, on=["customer_id", "line"])
    k0 = TREND_PRIOR_MONTHS
    d["shape"] = d["lam0"] * k0 + d["n"]
    d["rate_"] = k0 + d["T"]
    d["lam"] = d["shape"] / d["rate_"]
    prior_n = np.maximum(d["lam0"] * k0, 0.5)                 # prior worth ~k0 months of payments
    xbar = np.where(d["n"] > 0, d["eur"] / d["n"].clip(lower=1), 0.0)
    v1 = d["cv2"] * d["m0"] ** 2                              # variance of a single payment
    prec = prior_n / v1 + d["n"] / v1
    d["size_eur"] = (prior_n * d["m0"] + d["n"] * xbar) / (prior_n + d["n"])
    d["size_var"] = 1.0 / prec
    d["expected_month"] = d["lam"] * d["size_eur"]
    d["raw_month"] = d["eur"] / d["T"]
    return d


def draw_expected(d, n_draws, rng):
    """Posterior draws of expected monthly spend, shape (rows, n_draws)."""
    lam = rng.gamma(d["shape"].to_numpy()[:, None], 1.0 / d["rate_"].to_numpy()[:, None], (len(d), n_draws))
    size = rng.normal(d["size_eur"].to_numpy()[:, None], np.sqrt(d["size_var"].to_numpy())[:, None], (len(d), n_draws))
    return lam * np.clip(size, 0.01, None)


# ------------------------------------------------------------------ monthly normal model
def fit_monthly(mt, statfin_income):
    """Normal-normal shrinkage of each customer's mean monthly amount per line toward the peer group."""
    p = mt.groupby(["customer_id", "peer_group", "age_band", "line"])["amount"].agg(["mean", "var", "size"]).reset_index()
    p.columns = ["customer_id", "peer_group", "age_band", "line", "ybar", "s2", "T"]
    # per-customer variance shrunk toward the line median (some people are paid irregularly)
    # (floored at 1 €^2: lines like savings are all-zero for most people)
    s0 = p.groupby("line")["s2"].transform("median").clip(lower=1.0)
    nu0 = 5.0
    p["s2_post"] = ((nu0 * s0 + (p["T"] - 1) * p["s2"]) / (nu0 + p["T"] - 1)).clip(lower=1.0)
    g = p.groupby(["peer_group", "line"])
    p["mu_g"] = g["ybar"].transform("mean")
    p["tau2_g"] = (g["ybar"].transform("var") - g["s2_post"].transform("mean") / p["T"]).clip(lower=1.0)
    # Statistics Finland prior on the income peer-group mean (sd = 30 % of the national value)
    p = p.merge(statfin_income.rename(columns={"eur_month": "statfin_income"}), on="age_band", how="left")
    is_inc = (p["line"] == "income") & p["statfin_income"].notna()
    n_g = g["ybar"].transform("size")
    data_prec = n_g / (p["tau2_g"] + p["s2_post"] / p["T"])
    prior_prec = np.where(is_inc, 1.0 / (0.3 * p["statfin_income"].fillna(1)) ** 2, 0.0)
    p["mu_g"] = (data_prec * p["mu_g"] + prior_prec * p["statfin_income"].fillna(0)) / (data_prec + prior_prec)
    prec = 1.0 / p["tau2_g"] + p["T"] / p["s2_post"]
    p["post_mean"] = (p["mu_g"] / p["tau2_g"] + p["T"] * p["ybar"] / p["s2_post"]) / prec
    p["post_sd_month"] = np.sqrt(p["s2_post"])       # month-to-month predictive spread
    return p


# ------------------------------------------------------------------ helpers from raw transactions
def customer_facts(con):
    as_of = pd.Timestamp(con.sql("select as_of from meta").df()["as_of"].iloc[0])
    bal = con.sql("""select customer_id, arg_max(balance_after_eur, ts) balance from transactions group by 1""").df()
    pay = con.sql("""
        select customer_id, mode(extract(day from tx_date))::int payday
        from transactions where line='income' group by 1""").df()
    due = con.sql("""
        select customer_id, line, extract(day from tx_date)::int dom, sum(spend) eur
        from transactions where line in ('housing','utilities') group by all""").df()
    return as_of, bal, pay, due


def next_payday(as_of, day):
    y, m = as_of.year, as_of.month
    for _ in range(3):
        last = pd.Timestamp(y, m, 1) + pd.offsets.MonthEnd(0)
        cand = pd.Timestamp(y, m, min(day, last.day))
        if cand > as_of:
            return cand
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return as_of + pd.Timedelta(days=30)


def due_share(due, as_of, paydays):
    """Share of each customer's monthly housing/utility amount that falls between as_of and payday."""
    tot = due.groupby(["customer_id", "line"])["eur"].transform("sum")
    due = due.assign(share=due["eur"] / tot)
    days = {}
    for cid, pd_ in paydays.items():
        rng = pd.date_range(as_of + pd.Timedelta(days=1), pd_ - pd.Timedelta(days=1))
        days[cid] = set(rng.day)
    due["in_window"] = [d in days.get(c, set()) for c, d in zip(due["customer_id"], due["dom"])]
    return due[due["in_window"]].groupby(["customer_id", "line"])["share"].sum().unstack(fill_value=0.0)


# ------------------------------------------------------------------ safe to spend
def simulate_essentials(post, days, n_sim, rng):
    """Draws of essential spending (essential everyday lines + shocks) over each customer's window."""
    cust = post["customer_id"].unique()
    idx = pd.Index(cust)
    total = np.zeros((len(cust), n_sim))
    frac = (days.reindex(cust).to_numpy() / DPM)[:, None]
    for line in C.ESSENTIAL_EVERYDAY + ["shock"]:
        d = post[post["line"] == line].set_index("customer_id").reindex(cust)
        lam = rng.gamma(d["shape"].to_numpy()[:, None], 1.0 / d["rate_"].to_numpy()[:, None], (len(cust), n_sim))
        mx = np.clip(rng.normal(d["size_eur"].to_numpy()[:, None], np.sqrt(d["size_var"].to_numpy())[:, None],
                                (len(cust), n_sim)), 0.01, None)      # mean € per payment (posterior draw)
        s2 = d["sigma2"].to_numpy()[:, None]
        n = rng.poisson(lam * frac)
        if line == "shock":     # rare and heavy-tailed: sum individual lognormal payments (max 3 events)
            loc = np.log(mx) - s2 / 2
            sizes = np.exp(loc[..., None] + np.sqrt(s2)[..., None] * rng.standard_normal((len(cust), n_sim, 3)))
            mask = np.arange(3)[None, None, :] < np.minimum(n, 3)[..., None]
            total += (sizes * mask).sum(-1)
        else:                   # frequent: normal approximation of a sum of n payments
            sx = mx * np.sqrt(d["cv2"].to_numpy()[:, None])
            total += np.clip(n * mx + np.sqrt(n) * sx * rng.standard_normal(n.shape), 0, None)
    return pd.DataFrame(total, index=idx)


# ------------------------------------------------------------------ run everything
def run(db_path=C.DB_PATH, verbose=True):
    t0 = time.time()
    rng = np.random.default_rng(C.SEED)
    con = duckdb.connect(str(db_path))
    statfin_spend, statfin_income, cpi = load_priors()
    months = month_index(con)
    first, last = months[0], months[-1]
    recent_start = months[-C.TREND_RECENT_MONTHS]

    # ---- compound model on all months
    st_all = suff_stats(con, first, last)
    hyper = fit_compound(st_all, statfin_spend)
    post = posterior_compound(st_all, hyper)

    # ---- trend: earlier vs recent window. Each window is shrunk toward the customer's OWN long-run
    # level (prior worth TREND_PRIOR_MONTHS months), not toward the peer group - otherwise people far
    # from their peers would look like they are "trending" toward them.
    st_base = suff_stats(con, first, months[-C.TREND_RECENT_MONTHS - 1])
    st_rec = suff_stats(con, recent_start, last)
    own = post[["customer_id", "line", "lam", "size_eur", "cv2"]].rename(columns={"lam": "lam0", "size_eur": "m0"})
    pb, pr = window_posterior(st_base, own), window_posterior(st_rec, own)
    trend = []
    for line in C.EVERYDAY_LINES:
        # align both windows on customer_id (query row order is not guaranteed)
        b = pb[pb["line"] == line].sort_values("customer_id").reset_index(drop=True)
        r = pr[pr["line"] == line].set_index("customer_id").loc[b["customer_id"]].reset_index()
        eb, er = draw_expected(b, 400, rng), draw_expected(r, 400, rng)
        trend.append(pd.DataFrame({"customer_id": b["customer_id"], "line": line,
                                   "base_month": b["expected_month"], "recent_month": r["expected_month"],
                                   "base_raw": b["raw_month"], "recent_raw": r["raw_month"],
                                   "p_up": (er > eb).mean(1)}))
    trend = pd.concat(trend)

    # ---- peer comparison (within peer group) + national benchmark
    post["peer_median"] = post.groupby(["peer_group", "line"])["expected_month"].transform("median")
    post["peer_lam_median"] = post.groupby(["peer_group", "line"])["lam"].transform("median")
    post["peer_size_median"] = post.groupby(["peer_group", "line"])["size_eur"].transform("median")
    post["peer_pct"] = post.groupby(["peer_group", "line"])["expected_month"].rank(pct=True)
    post["peer_ratio"] = post["expected_month"] / post["peer_median"]
    post = post.merge(statfin_spend.rename(columns={"eur_month": "national_eur"}), on=["age_band", "line"], how="left")
    customer_line = post.merge(trend, on=["customer_id", "line"], how="left")

    # ---- monthly lines: income, rent, utilities, savings
    mt = monthly_totals(con)
    mon = fit_monthly(mt, statfin_income)
    monthly = mon.pivot(index="customer_id", columns="line", values="post_mean")
    income_sd = mon[mon["line"] == "income"].set_index("customer_id")["post_sd_month"]
    peer_income = mon[mon["line"] == "income"].groupby("peer_group")["post_mean"].median()

    # ---- safe to spend
    as_of, bal, pay, due = customer_facts(con)
    cust = con.sql("select * from customers").df().set_index("customer_id")
    payday_dom = pay.set_index("customer_id")["payday"].reindex(cust.index).fillna(15).astype(int)
    paydays = {c: next_payday(as_of, d) for c, d in payday_dom.items()}
    days = pd.Series({c: max((p - as_of).days, 1) for c, p in paydays.items()})
    share = due_share(due, as_of, paydays).reindex(cust.index, fill_value=0.0)
    reg_due = (monthly["housing"] * share.get("housing", 0) + monthly["utilities"] * share.get("utilities", 0)).clip(lower=0)
    ess = simulate_essentials(post, days, C.N_SIM, rng)
    balance = bal.set_index("customer_id")["balance"].reindex(cust.index)
    left = balance.to_numpy()[:, None] - reg_due.to_numpy()[:, None] - ess.to_numpy()
    cash_safe = np.quantile(left, C.SAFE_QUANTILE, axis=1) - C.SAFE_CUSHION_EUR
    weeks = np.maximum(days.reindex(cust.index).to_numpy() / 7, 1)
    cash_week = cash_safe / weeks

    pv = post.pivot(index="customer_id", columns="line", values="expected_month").reindex(cust.index)
    essentials_month = pv[C.ESSENTIAL_EVERYDAY].sum(axis=1)
    discretionary_month = pv[C.DISCRETIONARY].sum(axis=1)
    regular_month = monthly["housing"] + monthly["utilities"]
    savings_month = monthly["savings_transfer"].clip(lower=0)
    budget_month = monthly["income"] - regular_month - essentials_month - pv["shock"] - savings_month
    budget_week = budget_month * 7 / DPM
    safe_week = np.floor(np.clip(np.minimum(cash_week, budget_week), 0, None) / 5) * 5

    # surprise fund: 90th percentile of a year of shocks
    sp = post[post["line"] == "shock"].set_index("customer_id").reindex(cust.index)
    n_year = rng.poisson(sp["lam"].to_numpy()[:, None] * 12, (len(cust), 1000))
    loc = (np.log(sp["size_eur"]) - sp["sigma2"] / 2).to_numpy()
    sizes = np.exp(loc[:, None, None] + np.sqrt(sp["sigma2"].to_numpy())[:, None, None]
                   * rng.standard_normal((len(cust), 1000, 6)))
    year_total = (sizes * (np.arange(6)[None, None, :] < np.minimum(n_year, 6)[..., None])).sum(-1)
    # at least one typical surprise, even for people who rarely get them
    surprise_fund = np.ceil(np.maximum(np.quantile(year_total, 0.9, axis=1), sp["size_eur"].to_numpy()) / 50) * 50

    total_spend = regular_month + pv["shock"] + pv[C.EVERYDAY_LINES + ["big_purchase"]].sum(axis=1)
    summary = pd.DataFrame({
        "income_month": monthly["income"], "income_sd": income_sd, "peer_income_median": cust["peer_group"].map(peer_income),
        "payday_dom": payday_dom, "next_payday": pd.Series(paydays), "days_to_payday": days,
        "balance": balance, "regular_month": regular_month, "housing_month": monthly["housing"],
        "utilities_month": monthly["utilities"], "shock_month": pv["shock"], "essentials_month": essentials_month,
        "discretionary_month": discretionary_month, "big_purchase_month": pv["big_purchase"],
        "savings_month": savings_month, "total_spend_month": total_spend,
        "basket1_share": regular_month / total_spend, "basket2_share": pv["shock"] / total_spend,
        "basket3_share": (total_spend - regular_month - pv["shock"]) / total_spend,
        "savings_rate": savings_month / monthly["income"].where(monthly["income"] > 0),
        "shocks_per_year": sp["lam"] * 12, "typical_shock_eur": sp["size_eur"], "surprise_fund": surprise_fund,
        "safe_week_cash": cash_week, "safe_week_budget": budget_week, "safe_to_spend_week": safe_week,
        "safe_binding": np.where(cash_week < budget_week, "cash_until_payday", "monthly_budget"),
    }, index=cust.index)
    summary.index.name = "customer_id"
    summary = summary.reset_index().merge(cust.reset_index()[["customer_id", "customer_age", "age_band", "area", "peer_group"]],
                                          on="customer_id")
    summary["as_of"] = as_of

    for name, df in [("model_hyper", hyper), ("customer_line", customer_line), ("customer_summary", summary)]:
        con.register("tmp_df", df)
        con.sql(f"create or replace table {name} as select * from tmp_df")
        con.unregister("tmp_df")
    con.close()
    if verbose:
        print(f"model run in {time.time() - t0:.1f}s  (as_of {as_of.date()}, CPI factor {cpi:.3f})")
    return hyper, customer_line, summary


if __name__ == "__main__":
    hyper, cl, summ = run()
    pd.set_option("display.width", 200)
    print("\nStatistics Finland weight on peer-group level (mean over groups):")
    print(hyper.groupby("line")["statfin_weight"].mean().round(4).to_string())
    print("\nsummary quantiles:")
    print(summ[["income_month", "regular_month", "essentials_month", "discretionary_month", "shock_month",
                "savings_month", "balance", "safe_to_spend_week", "surprise_fund", "shocks_per_year"]]
          .describe(percentiles=[.1, .5, .9]).round(0).to_string())
