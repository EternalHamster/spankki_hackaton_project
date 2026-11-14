"""Hierarchical empirical-Bayes spending model.

Structure:  Statistics Finland  ->  peer group (age band x area)  ->  customer  ->  months  ->  transactions

1. Spending lines (everyday, shocks, big purchases): compound "frequency x size" model
       N_it   ~ overdispersed count, mean lambda_i, variance phi_i * lambda_i   (payments per month)
       lambda_i ~ Gamma(a_gk, b_gk)              peer-group prior -> Gamma(a + n/phi_g, b + T/phi_g) posterior
       xbar_i ~ Normal(m_i, cv_k^2 M^2 / n_i)  average € per transaction (constant coefficient of variation)
       m_i    ~ Normal(M_gk, t_k^2 M_gk^2)      peer-group prior          -> conjugate Normal posterior
       log M_gk ~ Normal(log M0_gk, STATFIN_PRIOR_SD^2)  Statistics Finland prior on the peer-group level
   expected monthly spend  E_i = lambda_i * m_i

   phi_i is the month-to-month burstiness of the customer (variance / mean of monthly counts). Real
   months are far burstier than Poisson (groceries: variance ~4x the mean), so a plain Poisson model is
   over-confident. phi_g (peer-group burstiness) down-weights the data in the rate update, which is the
   classic credibility formula: weight on own history = T / (T + b * phi_g). phi_i (the customer's own
   burstiness, shrunk toward a line-level curve) is used when simulating their future months.
   (Sizes are modelled on the € scale on purpose: a log-normal size model over-estimated the mean by
    ~10 % on lines where the largest 5 % of payments are split off as shocks / big purchases.)

2. Regular income, rent, utilities, savings transfers: normal-normal model on monthly totals, shrunk to
   the peer group (income with a Statistics Finland prior on the peer-group mean).

3. Payday: Beta-Binomial model of "salary arrives late" (at month end instead of the usual day).

4. Derived: peer comparison, trend (permutation null + false discovery rate), safe-to-spend (Monte
   Carlo until the salary arrives), surprise fund, safe-to-save.

Hyperparameters are estimated from all customers (method of moments). Everything per customer is
closed form, so scoring one customer takes milliseconds and a full run takes well under a minute.
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


def _in(values):
    return "(" + ",".join(f"'{v}'" for v in values) + ")"


def _d(ts):
    return f"DATE '{pd.Timestamp(ts):%Y-%m-%d}'"


# ------------------------------------------------------------------ data access
def use_as_of(con, as_of=None):
    """Create temp views `tx` and `cml` that only contain data up to `as_of` (default: end of data).

    Everything below reads these views, so the whole model can be re-run "as of" an earlier date
    (used for the calibration backtest in validate.py). Returns as_of as a Timestamp.
    """
    data_end = pd.Timestamp(con.sql("select max(tx_date) from transactions").fetchall()[0][0])
    as_of = data_end if as_of is None else min(pd.Timestamp(as_of), data_end)
    con.sql(f"create or replace temp view tx as select * from transactions where tx_date <= {_d(as_of)}")
    con.sql(f"""create or replace temp view cml as
                    select * from customer_month_line where last_day(month) <= {_d(as_of)}""")
    return as_of


def month_index(con):
    """Months that are complete for every customer, up to as_of.

    Accounts open on different days of the first month, so that month is dropped unless every
    account already existed on its first day.
    """
    months = pd.to_datetime(con.sql("select distinct month from cml order by 1").df()["month"]).tolist()
    latest_start = pd.Timestamp(con.sql(
        "select max(d) from (select min(tx_date) d from transactions group by customer_id)").fetchall()[0][0])
    first_full = latest_start if latest_start.day == 1 else latest_start + pd.offsets.MonthBegin(1)
    return [m for m in months if m >= first_full.normalize()]


def suff_stats(con, start, end, lines=COMPOUND_LINES):
    """Sufficient statistics per customer x line for months in [start, end] (inclusive, as dates).

    sn2 = sum over months of (payments in the month)^2, used for the month-to-month burstiness.
    Rows are ordered (customer_id, line) so that results are reproducible.
    """
    df = con.sql(f"""
        with pm as (
          select customer_id, line, month, count(*) n, sum(ln(spend)) slx, sum(ln(spend)^2) sslx,
                 sum(spend) eur, sum(spend^2) sx2
          from tx
          where line in {_in(lines)} and spend > 0 and month between {_d(start)} and {_d(end)}
          group by all),
        s as (
          select customer_id, line, sum(n) n, sum(slx) slx, sum(sslx) sslx, sum(eur) eur, sum(sx2) sx2,
                 sum(n * n) sn2
          from pm group by all)
        select c.customer_id, c.peer_group, c.age_band, l.line,
               coalesce(s.n, 0) n, coalesce(s.slx, 0) slx, coalesce(s.sslx, 0) sslx, coalesce(s.eur, 0) eur,
               coalesce(s.sx2, 0) sx2, coalesce(s.sn2, 0) sn2
        from customers c cross join (select unnest({list(lines)}) line) l
        left join s using (customer_id, line)
        order by c.customer_id, l.line""").df()
    for col in ["n", "sn2"]:
        df[col] = df[col].astype(float)
    df["T"] = (end.year - start.year) * 12 + end.month - start.month + 1
    return df


def monthly_totals(con, start, end, lines=MONTHLY_LINES):
    """Monthly amounts per customer for the regular lines.

    "income" is REGULAR income: salary, plus other income only if it is recurring (present in at least
    a third of the months). One-off windfalls must not raise the monthly budget.
    """
    n_months = (end.year - start.year) * 12 + end.month - start.month + 1
    return con.sql(f"""
        with inc as (
          select customer_id, month,
                 coalesce(sum(tx_amount_eur) filter (where category = 'Salary'), 0) sal,
                 coalesce(sum(tx_amount_eur) filter (where category <> 'Salary'), 0) oth
          from tx where line = 'income' and month between {_d(start)} and {_d(end)} group by all),
        rec as (select customer_id, count(*) filter (where oth > 0) n_oth from inc group by 1)
        select m.customer_id, c.peer_group, c.age_band, m.line, m.month,
               case when m.line = 'income'
                    then coalesce(i.sal, 0) + case when coalesce(r.n_oth, 0) >= {n_months} / 3.0
                                                   then coalesce(i.oth, 0) else 0 end
                    else m.amount end as amount
        from cml m join customers c using (customer_id)
        left join inc i on i.customer_id = m.customer_id and i.month = m.month
        left join rec r on r.customer_id = m.customer_id
        where m.line in {_in(lines)} and m.month between {_d(start)} and {_d(end)}
        order by m.customer_id, m.line, m.month""").df()


# ------------------------------------------------------------------ compound model
def _within_var(st):
    """Customer's own month-to-month variance of payment counts (NaN with fewer than 2 months)."""
    r = st["n"] / st["T"]
    return np.where(st["T"] > 1, (st["sn2"] - st["T"] * r ** 2) / (st["T"] - 1).clip(lower=1), np.nan)


def _dispersion_curve(st):
    """Line-level burstiness curve  log(phi) = alpha + beta * log(lambda), fitted on rate quintiles.

    disp_lo / disp_hi is the range of rates the curve was fitted on; it is not extrapolated beyond it.
    """
    rows = []
    for line, d in st[(st["n"] > 0) & st["v"].notna()].groupby("line"):
        alpha, beta, lo, hi = 0.0, 0.0, 1e-6, 1e6
        if len(d) >= 50:
            bins = pd.qcut(d["r"], 5, duplicates="drop")
            g = d.groupby(bins, observed=True).agg(r=("r", "mean"), v=("v", "sum"), m=("r", "sum"))
            phi = (g["v"] / g["m"]).clip(lower=0.3)
            lo, hi = float(g["r"].min()), float(g["r"].max())
            if len(g) >= 2:
                beta, alpha = np.polyfit(np.log(g["r"]), np.log(phi), 1)
            else:
                alpha = float(np.log(phi.iloc[0]))
        rows.append((line, alpha, beta, lo, hi))
    return pd.DataFrame(rows, columns=["line", "disp_alpha", "disp_beta", "disp_lo", "disp_hi"])


def fit_compound(st, statfin_spend, dispersion=True):
    """Peer-group hyperparameters per line. Returns one row per (peer_group, line)."""
    st = st.copy()
    st["r"] = st["n"] / st["T"]
    st["v"] = _within_var(st)
    if not dispersion:                     # plain Poisson: variance of a monthly count = its mean
        st["v"] = st["r"]

    # ---- frequency: Gamma prior by method of moments (one-way random-effects ANOVA on the rates):
    #      Var(observed rate) = Var(lambda) + E[within-customer variance of a month] / T
    freq = (st.groupby(["peer_group", "age_band", "line"])
              .agg(m=("r", "mean"), v=("r", "var"), w=("v", "mean"), T=("T", "first"), n_cust=("r", "size")).reset_index())
    freq["w"] = freq["w"].fillna(freq["m"])
    excess = freq["v"] - freq["w"] / freq["T"]
    freq["a"] = np.where(excess > 1e-9, freq["m"] ** 2 / excess.clip(lower=1e-9), 1e4).clip(0.05, 1e4)
    freq["b"] = freq["a"] / freq["m"].clip(lower=1e-6)
    # peer-group burstiness: expected within-customer variance of a month / mean rate (1 = Poisson)
    freq["phi_g"] = (freq["w"] / freq["m"].clip(lower=1e-6)).clip(C.DISP_MIN, C.DISP_MAX) if dispersion else 1.0
    curve = _dispersion_curve(st) if dispersion else pd.DataFrame(
        {"line": sorted(st["line"].unique()), "disp_alpha": 0.0, "disp_beta": 0.0, "disp_lo": 1e-6, "disp_hi": 1e6})

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
    h = h.merge(cv2, on="line").merge(t2rel, on="line").merge(sig2, on="line").merge(curve, on="line", how="left")
    h = h.fillna({"disp_alpha": 0.0, "disp_beta": 0.0, "disp_lo": 1e-6, "disp_hi": 1e6})
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
    return (h[["peer_group", "age_band", "line", "n_cust", "a", "b", "phi_g", "M", "T2", "cv2", "sigma2",
               "disp_alpha", "disp_beta", "disp_lo", "disp_hi", "M_data", "statfin_eur", "statfin_weight"]]
            .sort_values(["peer_group", "line"]).reset_index(drop=True))


def posterior_compound(st, hyper):
    """Closed-form per-customer posteriors. Adds burstiness, rate, size, expected monthly spend."""
    d = st.merge(hyper[["peer_group", "line", "a", "b", "phi_g", "M", "T2", "cv2", "sigma2", "disp_alpha", "disp_beta",
                        "disp_lo", "disp_hi"]], on=["peer_group", "line"])
    # Rate: credibility (Buhlmann) update. Bursty months carry less information than Poisson months,
    # so the data is down-weighted by the peer group's burstiness phi_g. The weight on the customer's
    # own average is T / (T + b * phi_g), the same for everyone in the group, so it adds no bias.
    d["shape"] = d["a"] + d["n"] / d["phi_g"]
    d["rate_"] = d["b"] + d["T"] / d["phi_g"]
    d["lam"] = d["shape"] / d["rate_"]                       # transactions per month
    # Customer's own burstiness (variance / mean of monthly counts), used when simulating future
    # months: the line-level curve at the customer's rate, blended with their own history.
    phi0 = np.exp(d["disp_alpha"] + d["disp_beta"] * np.log(d["lam"].clip(d["disp_lo"], d["disp_hi"])))
    own_ok = (d["n"] > 0) & (d["T"] >= 3)
    own = np.where(own_ok, _within_var(d) / (d["n"] / d["T"]).where(own_ok, 1), 0.0)
    df_own = np.where(own_ok, d["T"] - 1, 0.0)
    no_curve = (d["disp_alpha"] == 0) & (d["disp_beta"] == 0)           # dispersion switched off
    d["phi"] = np.where(no_curve, 1.0, ((C.DISP_PRIOR_DF * phi0 + df_own * own) / (C.DISP_PRIOR_DF + df_own))
                        .clip(C.DISP_MIN, C.DISP_MAX))
    xbar = np.where(d["n"] > 0, d["eur"] / d["n"].clip(lower=1), 0.0)
    data_prec = np.where(d["n"] > 0, d["n"] / (d["cv2"] * d["M"] ** 2), 0.0)
    prec = 1.0 / d["T2"] + data_prec
    d["size_eur"] = (d["M"] / d["T2"] + data_prec * xbar) / prec   # € per transaction
    d["size_var"] = 1.0 / prec
    d["expected_month"] = d["lam"] * d["size_eur"]
    d["raw_month"] = d["eur"] / d["T"]
    return d


# ------------------------------------------------------------------ seasonality and trend
def season_factors(con, months):
    """Calendar-month factor per line (population level, mean 1): line -> {month of year: factor}."""
    df = con.sql(f"""select line, month, sum(amount) eur from cml
                     where month between {_d(months[0])} and {_d(months[-1])} group by all order by 1, 2""").df()
    df["moy"] = pd.to_datetime(df["month"]).dt.month
    out = {}
    for line, d in df.groupby("line"):
        mean = d["eur"].mean()
        f = (d.groupby("moy")["eur"].mean() / mean) if mean > 0 and len(d) >= 12 else pd.Series(dtype=float)
        out[line] = {m: float(f.get(m, 1.0)) for m in range(1, 13)}
    return out


def _trend_z(A, recent):
    """z-score of (mean of recent months - mean of earlier months) per row of A (customers x months)."""
    rec, base = A[:, recent], A[:, ~recent]
    R, B = rec.shape[1], base.shape[1]
    mean = A.mean(1)
    sp2 = ((R - 1) * rec.var(1, ddof=1) + (B - 1) * base.var(1, ddof=1)) / (R + B - 2)
    # shrink each customer's month-to-month variance toward the line's typical coefficient of variation
    cv = np.sqrt(A.var(1, ddof=1)) / np.where(mean > 0, mean, 1)
    s0 = (np.median(cv[mean >= 5]) if (mean >= 5).any() else 1.0) * mean
    nu = 4.0
    sp2 = (nu * s0 ** 2 + (R + B - 2) * sp2) / (nu + R + B - 2)
    return (rec.mean(1) - base.mean(1)) / np.sqrt(np.maximum(sp2, 1.0) * (1 / R + 1 / B))


def _fdr_prob(z, null):
    """P(real effect) = 1 - tail-area false discovery rate of z against the permutation null."""
    order = np.argsort(-z)
    zs = z[order]
    p0 = (len(null) - np.searchsorted(null, zs, side="left") + 1) / (len(null) + 1)   # null is sorted
    seen = np.arange(1, len(zs) + 1) / len(zs)
    fdr = np.minimum(1.0, p0 / seen)
    q = np.minimum.accumulate(fdr[::-1])[::-1]              # monotone: less extreme never looks better
    out = np.empty(len(z))
    out[order] = 1 - q
    return out


def trend_model(con, months, season, rng, lines=C.EVERYDAY_LINES):
    """Has the customer's monthly level really changed in the last TREND_RECENT_MONTHS months?

    Months are bursty and mildly seasonal, so a naive "recent vs before" test flags thousands of
    customers who just had a few random busy months. Here:
      1. monthly € are divided by the population's calendar-month factor (seasonality),
      2. the recent-vs-earlier difference is standardised by the customer's own month-to-month spread,
      3. the same statistic is computed for random relabelings of the months (permutation null),
      4. p_up / p_down = 1 - false discovery rate: of the customers at least this extreme, the share
         that is real. This handles the multiple-comparison problem (71,000 customer x line tests).
    """
    R = C.TREND_RECENT_MONTHS
    T = len(months)
    df = con.sql(f"""select customer_id, line, month, amount from cml
                     where line in {_in(lines)} and month between {_d(months[0])} and {_d(months[-1])}
                     order by customer_id, line, month""").df()
    recent = np.arange(T) >= T - R
    perms = [rng.permutation(T) for _ in range(C.TREND_PERMUTATIONS)]
    out, nulls = [], []
    for line in lines:
        Y = df[df["line"] == line].pivot(index="customer_id", columns="month", values="amount").sort_index()
        f = np.array([season[line][pd.Timestamp(m).month] for m in Y.columns])
        A = Y.to_numpy() / f
        elig = A.mean(1) >= 5                              # too little spending to talk about a trend
        z = np.zeros(len(A))
        p_up, p_down = np.zeros(len(A)), np.zeros(len(A))
        if elig.sum() > 20 and T - R >= 6:
            Ae = A[elig]
            z[elig] = _trend_z(Ae, recent)
            null = np.sort(np.concatenate([_trend_z(Ae[:, p], recent) for p in perms]))
            p_up[elig] = _fdr_prob(z[elig], null)
            grid = np.round(np.concatenate([[0.0001, 0.001], np.arange(0.005, 1.0, 0.005), [0.999, 0.9999]]), 4)
            nulls.append(pd.DataFrame({"line": line, "quantile": grid, "null_z": np.quantile(null, grid),
                                       "n_customers": int(elig.sum()), "n_null": len(null)}))
            p_down[elig] = _fdr_prob(-z[elig], -null[::-1])
        raw = Y.to_numpy()
        out.append(pd.DataFrame({
            "customer_id": Y.index, "line": line,
            "base_month": raw[:, ~recent].mean(1), "recent_month": raw[:, recent].mean(1),      # facts
            "base_adj": A[:, ~recent].mean(1), "recent_adj": A[:, recent].mean(1),               # season-adjusted
            "trend_z": z, "p_up": p_up, "p_down": p_down,
            # last complete month against the customer's own earlier months (a fact, not a trend claim)
            "last_month_eur": raw[:, -1], "usual_month_eur": raw[:, :-1].mean(1),
            "last_month_is_record": raw[:, -1] > raw[:, :-1].max(1)}))
    null_table = (pd.concat(nulls, ignore_index=True) if nulls else
                  pd.DataFrame(columns=["line", "quantile", "null_z", "n_customers", "n_null"]))
    return pd.concat(out, ignore_index=True), null_table


# ------------------------------------------------------------------ monthly normal model
def fit_monthly(mt, statfin_income):
    """Normal-normal shrinkage of each customer's mean monthly amount per line toward the peer group."""
    p = mt.groupby(["customer_id", "peer_group", "age_band", "line"])["amount"].agg(["mean", "var", "size"]).reset_index()
    p.columns = ["customer_id", "peer_group", "age_band", "line", "ybar", "s2", "T"]
    p["s2"] = p["s2"].fillna(0.0)
    # per-customer variance shrunk toward the line median (some people are paid irregularly)
    # (floored at 1 €^2: lines like savings are all-zero for most people)
    s0 = p.groupby("line")["s2"].transform("median").clip(lower=1.0)
    nu0 = 5.0
    p["s2_post"] = ((nu0 * s0 + (p["T"] - 1) * p["s2"]) / (nu0 + p["T"] - 1)).clip(lower=1.0)
    g = p.groupby(["peer_group", "line"])
    ybar_g = g["ybar"].transform("mean")
    noise_g = (p["s2_post"] / p["T"]).groupby([p["peer_group"], p["line"]]).transform("mean")
    p["tau2_g"] = (g["ybar"].transform("var").fillna(0.0) - noise_g).clip(lower=1.0)
    # Statistics Finland prior on the income peer-group mean (sd = 30 % of the national value)
    p = p.merge(statfin_income.rename(columns={"eur_month": "statfin_income"}), on="age_band", how="left")
    is_inc = (p["line"] == "income") & p["statfin_income"].notna()
    n_g = g["ybar"].transform("size")
    data_prec = n_g / (p["tau2_g"] + noise_g)                # same for everyone in the peer group
    prior_prec = np.where(is_inc, 1.0 / (0.3 * p["statfin_income"].fillna(1)) ** 2, 0.0)
    p["mu_g"] = (data_prec * ybar_g + prior_prec * p["statfin_income"].fillna(0)) / (data_prec + prior_prec)
    prec = 1.0 / p["tau2_g"] + p["T"] / p["s2_post"]
    p["post_mean"] = (p["mu_g"] / p["tau2_g"] + p["T"] * p["ybar"] / p["s2_post"]) / prec
    p["post_sd_month"] = np.sqrt(p["s2_post"])       # month-to-month predictive spread
    return p


# ------------------------------------------------------------------ payday, balance, bills
def payday_model(con, customers):
    """Usual payday and the probability that the next salary arrives late (at month end instead).

    late_i ~ Binomial(n_i, p_i),  p_i ~ Beta(alpha, beta) with alpha, beta from all customers.
    Returns a frame indexed by customer_id: payday_dom, p_late, n_salaries.
    """
    sal = con.sql("""select customer_id, extract(day from tx_date)::int d, count(*) n
                     from tx where category = 'Salary' group by all order by 1, 2""").df()
    # most common salary day; ties -> the earlier day (deterministic)
    top = (sal.sort_values(["customer_id", "n", "d"], ascending=[True, False, True])
              .drop_duplicates("customer_id").set_index("customer_id")["d"])
    sal = sal.join(top.rename("usual"), on="customer_id")
    sal["late"] = (sal["d"] > sal["usual"] + C.LATE_PAYDAY_GAP_DAYS) * sal["n"]
    g = sal.groupby("customer_id").agg(n_sal=("n", "sum"), late=("late", "sum"), usual=("usual", "first"))
    g = g.reindex(customers)
    g["usual"] = g["usual"].fillna(15).astype(int)
    g[["n_sal", "late"]] = g[["n_sal", "late"]].fillna(0.0)
    month_end = g["usual"] >= C.MONTH_END_PAYDAY                  # paid at month end: the day itself varies
    g["payday_dom"] = np.where(month_end, 31, g["usual"])
    # Beta prior by method of moments (beta-binomial) over customers paid mid-month
    d = g[~month_end & (g["n_sal"] >= 6)]
    if len(d) >= 30:
        share = d["late"] / d["n_sal"]
        mu = float(share.mean())
        excess = share.var() - mu * (1 - mu) * (1 / d["n_sal"]).mean()
        k = mu * (1 - mu) / excess - 1 if excess > 1e-6 else 500.0
        k = float(np.clip(k, 2.0, 500.0))
    else:
        mu, k = 0.1, 10.0
    g["p_late"] = np.where(month_end, 0.0, (mu * k + g["late"]) / (k + g["n_sal"]))
    out = g[["payday_dom", "p_late", "n_sal", "late", "usual"]].rename(
        columns={"n_sal": "n_salaries", "late": "n_late", "usual": "usual_salary_day"})
    # Beta(alpha, beta) prior of the late-salary probability, estimated from all mid-month customers
    out.attrs["prior"] = {"prior_mean": mu, "prior_strength": k, "alpha": mu * k, "beta": (1 - mu) * k}
    return out


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


def balances(con):
    """Balance after the customer's last transaction (the lower one if two share a timestamp)."""
    return con.sql("""
        with l as (select customer_id, max(ts) mts from tx group by 1)
        select t.customer_id, min(t.balance_after_eur) balance
        from tx t join l on t.customer_id = l.customer_id and t.ts = l.mts
        group by 1 order by 1""").df().set_index("customer_id")["balance"]


def due_share(con, as_of, ends, customers):
    """Share of the monthly housing / utility amount that falls after as_of and before `ends[cid]`.

    Uses each customer's own history of which days of the month these payments leave the account.
    """
    due = con.sql("""select customer_id, line, extract(day from tx_date)::int dom, sum(spend) eur
                     from tx where line in ('housing', 'utilities') group by all order by 1, 2, 3""").df()
    due["share"] = due["eur"] / due.groupby(["customer_id", "line"])["eur"].transform("sum")
    window = {e: set(pd.date_range(as_of + pd.Timedelta(days=1), e - pd.Timedelta(days=1)).day)
              for e in set(ends.values())}                 # few distinct paydays -> few distinct windows
    days = {c: window[e] for c, e in ends.items()}
    hit = np.fromiter((d in days.get(c, ()) for c, d in zip(due["customer_id"], due["dom"])), bool, len(due))
    out = due[hit].groupby(["customer_id", "line"])["share"].sum().unstack(fill_value=0.0)
    return out.reindex(index=customers, columns=["housing", "utilities"], fill_value=0.0).fillna(0.0)


# ------------------------------------------------------------------ simulation
def _draw_counts(lam_window, phi, frac, rng):
    """Payment counts over a window: mean lam_window, burstiness phi per month (scaled to the window)."""
    phi_w = 1 + (phi - 1) * np.minimum(frac, 1.0)
    over = np.broadcast_to(phi_w > 1.02, lam_window.shape)
    scale = np.broadcast_to(np.where(phi_w > 1.02, phi_w - 1, 1.0), lam_window.shape)
    mixed = rng.gamma(np.maximum(lam_window / scale, 1e-12), scale)
    return rng.poisson(np.where(over, mixed, lam_window))


def _draw_event_sizes(n, mean_size, sigma2, rng):
    """Sum of n lognormal payments with the given mean (heavy-tailed: shocks, big purchases)."""
    loc = np.broadcast_to(np.log(mean_size) - sigma2 / 2, n.shape).ravel()
    sd = np.broadcast_to(np.sqrt(sigma2), n.shape).ravel()
    idx = np.repeat(np.arange(n.size), n.ravel())           # one entry per simulated payment
    sizes = np.exp(loc[idx] + sd[idx] * rng.standard_normal(len(idx)))
    return np.bincount(idx, weights=sizes, minlength=n.size).reshape(n.shape)


def simulate_needs(post, customers, days, n_sim, rng, season_now=None):
    """Draws of essential spending (essential everyday lines + shocks) over each customer's window.

    days: array of window lengths aligned with `customers`. Returns an array (customers, n_sim).
    """
    season_now = season_now or {}
    total = np.zeros((len(customers), n_sim))
    frac = (np.asarray(days, float) / DPM)[:, None]
    for line in C.ESSENTIAL_EVERYDAY + ["shock"]:
        d = post[post["line"] == line].set_index("customer_id").reindex(customers)
        lam = rng.gamma(d["shape"].to_numpy()[:, None], 1.0 / d["rate_"].to_numpy()[:, None], (len(customers), n_sim))
        mx = np.clip(rng.normal(d["size_eur"].to_numpy()[:, None], np.sqrt(d["size_var"].to_numpy())[:, None],
                                (len(customers), n_sim)), 0.01, None)      # mean € per payment (posterior draw)
        n = _draw_counts(lam * frac * season_now.get(line, 1.0), d["phi"].to_numpy()[:, None], frac, rng)
        if line == "shock":     # rare and heavy-tailed: sum individual lognormal payments
            total += _draw_event_sizes(n, mx, d["sigma2"].to_numpy()[:, None], rng)
        else:                   # frequent: normal approximation of a sum of n payments
            sx = mx * np.sqrt(d["cv2"].to_numpy()[:, None])
            total += np.clip(n * mx + np.sqrt(n) * sx * rng.standard_normal(n.shape), 0, None)
    return total


# ------------------------------------------------------------------ run everything
def run(db_path=C.DB_PATH, as_of=None, write=True, verbose=True, n_sim=C.N_SIM, trend=True,
        dispersion=True, late_payday=True):
    """Fit everything as of `as_of` (default: end of data). write=False leaves the database untouched.

    dispersion / late_payday can be switched off to measure what they add (see validate.py).
    """
    t0 = time.time()
    rng = np.random.default_rng(C.SEED)
    con = duckdb.connect(str(db_path), read_only=not write)
    as_of = use_as_of(con, as_of)
    statfin_spend, statfin_income, cpi = load_priors()
    months = month_index(con)
    first, last = months[0], months[-1]
    cust = con.sql("select * from customers order by customer_id").df().set_index("customer_id")
    ids = cust.index.to_numpy()
    season = season_factors(con, months)

    # ---- compound model on all complete months
    st_all = suff_stats(con, first, last)
    hyper = fit_compound(st_all, statfin_spend, dispersion=dispersion)
    post = posterior_compound(st_all, hyper)

    # ---- peer comparison (within peer group) + national benchmark
    def add_peers(d, extra=()):
        g = d.groupby(["peer_group", "line"])
        d["peer_median"] = g["expected_month"].transform("median")
        d["peer_pct"] = g["expected_month"].rank(pct=True)
        d["peer_ratio"] = d["expected_month"] / d["peer_median"].where(d["peer_median"] > 0)
        for col in extra:
            d[f"peer_{col}_median"] = g[col].transform("median")
        return d.merge(statfin_spend.rename(columns={"eur_month": "national_eur"}), on=["age_band", "line"], how="left")

    post = add_peers(post, extra=())
    post["peer_lam_median"] = post.groupby(["peer_group", "line"])["lam"].transform("median")
    post["peer_size_median"] = post.groupby(["peer_group", "line"])["size_eur"].transform("median")

    # ---- monthly lines: regular income, rent, utilities, savings
    mon = fit_monthly(monthly_totals(con, first, last), statfin_income)
    monthly = mon.pivot(index="customer_id", columns="line", values="post_mean").reindex(ids)
    monthly_sd = mon.pivot(index="customer_id", columns="line", values="post_sd_month").reindex(ids)
    peer_income = mon[mon["line"] == "income"].groupby("peer_group")["post_mean"].median()
    # rent and bills also get a peer comparison row (no frequency x size split)
    reg = mon[mon["line"].isin(C.REGULAR_LINES)][["customer_id", "peer_group", "age_band", "line", "post_mean", "ybar", "T"]]
    reg = add_peers(reg.rename(columns={"post_mean": "expected_month", "ybar": "raw_month"}))

    customer_line = pd.concat([post, reg], ignore_index=True)
    if trend:
        trend_rows, trend_null = trend_model(con, months, season, rng)
        customer_line = customer_line.merge(trend_rows, on=["customer_id", "line"], how="left")
    else:
        trend_null = None
    customer_line = customer_line.sort_values(["customer_id", "line"]).reset_index(drop=True)

    # ---- safe to spend: simulate until the salary arrives (usual day, or late with probability p_late)
    pay = payday_model(con, ids)
    if not late_payday:
        pay["p_late"] = 0.0
    balance = balances(con).reindex(ids)
    pay_usual = {c: next_payday(as_of, d) for c, d in pay["payday_dom"].items()}
    pay_late = {c: p + pd.offsets.MonthEnd(0) for c, p in pay_usual.items()}
    season_now = {l: season[l][(as_of + pd.Timedelta(days=1)).month] for l in C.ESSENTIAL_EVERYDAY if l in season}

    def weekly_room(ends):
        """Per draw: € per week left for extras if the salary arrives on `ends`."""
        days = np.array([max((ends[c] - as_of).days, 1) for c in ids])
        share = due_share(con, as_of, ends, ids)
        bills = np.zeros((len(ids), n_sim))
        for line in C.REGULAR_LINES:          # expected share of the month's bill, with its usual spread
            mean = (monthly[line] * share[line]).to_numpy()[:, None]
            sd = (monthly_sd[line] * np.sqrt(share[line])).to_numpy()[:, None]
            bills += np.clip(mean + sd * rng.standard_normal((len(ids), n_sim)), 0, None)
        needs = bills + simulate_needs(post, ids, days, n_sim, rng, season_now)
        weeks = np.maximum(days / 7, 1)[:, None]
        return (balance.to_numpy()[:, None] - needs - C.SAFE_CUSHION_EUR) / weeks, days

    room_usual, days_usual = weekly_room(pay_usual)
    room_late, _ = weekly_room(pay_late)
    is_late = rng.random((len(ids), n_sim)) < pay["p_late"].to_numpy()[:, None]
    room = np.where(is_late, room_late, room_usual)
    cash_week = np.quantile(room, C.SAFE_QUANTILE, axis=1)

    pv = post.pivot(index="customer_id", columns="line", values="expected_month").reindex(ids)
    essentials_month = pv[C.ESSENTIAL_EVERYDAY].sum(axis=1)
    discretionary_month = pv[C.DISCRETIONARY].sum(axis=1)
    regular_month = monthly["housing"] + monthly["utilities"]
    savings_month = monthly["savings_transfer"].clip(lower=0)
    budget_month = monthly["income"] - regular_month - essentials_month - pv["shock"] - savings_month
    budget_week = budget_month * 7 / DPM

    # ---- surprise fund: 90th percentile of a year of shocks, at least one typical shock
    sp = post[post["line"] == "shock"].set_index("customer_id").reindex(ids)
    lam_year = np.broadcast_to(sp["lam"].to_numpy()[:, None] * 12, (len(ids), 1000))
    n_year = _draw_counts(lam_year, sp["phi"].to_numpy()[:, None], 12.0, rng)
    year_total = _draw_event_sizes(n_year, sp["size_eur"].to_numpy()[:, None], sp["sigma2"].to_numpy()[:, None], rng)
    surprise_fund = np.ceil(np.maximum(np.quantile(year_total, 0.9, axis=1), sp["size_eur"].to_numpy()) / 50) * 50

    # ---- large payments that are flagged instead of modelled still count as spending
    unusual = con.sql(f"""select customer_id, sum(spend) / {len(months)} eur from tx
                          where line = 'anomaly' and month between {_d(first)} and {_d(last)}
                          group by 1""").df().set_index("customer_id")["eur"].reindex(ids).fillna(0.0)

    everyday_month = pv[C.EVERYDAY_LINES + ["big_purchase"]].sum(axis=1) + unusual
    total_spend = regular_month + pv["shock"] + everyday_month
    summary = pd.DataFrame({
        "income_month": monthly["income"], "income_sd": monthly_sd["income"],
        "peer_income_median": cust["peer_group"].map(peer_income),
        "payday_dom": pay["payday_dom"], "p_late_payday": pay["p_late"],  # counts behind it: customer_payday
        "next_payday": pd.Series(pay_usual), "days_to_payday": pd.Series(days_usual, index=ids),
        "balance": balance, "regular_month": regular_month, "housing_month": monthly["housing"],
        "utilities_month": monthly["utilities"], "shock_month": pv["shock"], "essentials_month": essentials_month,
        "discretionary_month": discretionary_month, "big_purchase_month": pv["big_purchase"],
        "unusual_month": unusual, "savings_month": savings_month, "total_spend_month": total_spend,
        "basket1_share": regular_month / total_spend, "basket2_share": pv["shock"] / total_spend,
        "basket3_share": everyday_month / total_spend,
        "savings_rate": savings_month / monthly["income"].where(monthly["income"] > 0),
        "shocks_per_year": sp["lam"] * 12, "typical_shock_eur": sp["size_eur"], "surprise_fund": surprise_fund,
        "safe_week_cash": cash_week, "safe_week_budget": budget_week,
    }, index=ids)
    summary.index.name = "customer_id"
    summary = summary.reset_index().merge(cust.reset_index()[["customer_id", "customer_age", "age_band", "area", "peer_group"]],
                                          on="customer_id")
    summary["as_of"] = as_of

    # ---- actual cash flow over the last 12 complete months (facts, not shrunk estimates). Used for
    # statements about what the customer DID, e.g. "you spend more than comes in".
    m12 = months[-12:] if len(months) >= 12 else months
    flows = con.sql(f"""
        select customer_id, month,
               coalesce(sum(tx_amount_eur) filter (where line = 'income'), 0)                       as income,
               coalesce(sum(tx_amount_eur) filter (where category = 'Salary'), 0)                   as salary,
               coalesce(sum(spend) filter (where line not in ('income', 'savings_transfer')), 0)    as spend,
               coalesce(sum(spend) filter (where line = 'savings_transfer'), 0)                     as savings,
               coalesce(sum(spend) filter (where line in {_in(C.DISCRETIONARY)}), 0)                as extras
        from tx where month between {_d(m12[0])} and {_d(m12[-1])} group by all order by 1, 2""").df()
    # dense customer x month grid with regular income (salary + recurring other income)
    grid = (monthly_totals(con, m12[0], m12[-1], ["income"])[["customer_id", "month", "amount"]]
            .rename(columns={"amount": "income_regular"}))
    flows = grid.merge(flows, on=["customer_id", "month"], how="left").fillna(
        {"income": 0.0, "salary": 0.0, "spend": 0.0, "savings": 0.0, "extras": 0.0})
    f = flows.groupby("customer_id")[["income", "income_regular", "spend", "savings", "extras"]].mean().reindex(ids)
    actual = pd.DataFrame({"customer_id": ids, "income_12m": f["income"].to_numpy(),
                           "income_regular_12m": f["income_regular"].to_numpy(), "spend_12m": f["spend"].to_numpy(),
                           "savings_12m": f["savings"].to_numpy(), "extras_12m": f["extras"].to_numpy()})
    summary = summary.merge(actual, on="customer_id", how="left")
    summary["net_12m"] = summary["income_12m"] - summary["spend_12m"] - summary["savings_12m"]

    # ---- safe-to-spend must also hold under the LAST 12 MONTHS' needs: the long-run estimates lag behind
    # customers whose bills/essentials went up recently. Take the most conservative of the three.
    # (Net withdrawals from savings are not income: they do not raise the budget.)
    needs_12m = summary["spend_12m"] - summary["extras_12m"]
    summary["safe_week_budget_12m"] = (summary["income_regular_12m"] - needs_12m
                                       - summary["savings_12m"].clip(lower=0)) * 7 / DPM
    limits = summary[["safe_week_cash", "safe_week_budget", "safe_week_budget_12m"]]
    summary["safe_to_spend_week"] = np.floor(limits.min(axis=1).clip(lower=0) / 5) * 5
    summary["safe_binding"] = limits.idxmin(axis=1).map({"safe_week_cash": "cash_until_payday",
                                                         "safe_week_budget": "monthly_budget",
                                                         "safe_week_budget_12m": "recent_budget"})

    # ---- safe to save: how much more could go to savings every month with today's habits?
    # Posterior of the long-run monthly surplus (regular income - all spending - current saving) from
    # the last 12 months; take its SAVE_QUANTILE (a cautious estimate), rounded down to €10.
    flows["net_regular"] = flows["income_regular"] - flows["spend"] - flows["savings"]
    surplus_se = (flows.groupby("customer_id")["net_regular"].std().reindex(ids).fillna(0.0).to_numpy()
                  / np.sqrt(len(m12)))
    surplus_mean = (summary["income_regular_12m"] - summary["spend_12m"]
                    - summary["savings_12m"].clip(lower=0)).to_numpy()
    summary["surplus_month"] = surplus_mean
    summary["safe_to_save_month"] = np.floor(np.clip(surplus_mean - C.SAVE_T_QUANTILE * surplus_se, 0, None) / 10) * 10
    # how far the account balance is from covering the surprise fund (0 = already covered)
    summary["surprise_fund_gap"] = (summary["surprise_fund"] + C.SAFE_CUSHION_EUR - summary["balance"]).clip(lower=0)

    if write:
        # ---- the rest of the model, so the database is self-contained (see README "What is in coach.duckdb")
        qs = [0.01, 0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99]
        sim = pd.DataFrame({"customer_id": ids, "n_draws": n_sim})
        for name, draws in [("room_week", room), ("room_week_if_on_time", room_usual),
                            ("room_week_if_late", room_late), ("shocks_year_eur", year_total)]:
            for q, col in zip(qs, np.quantile(draws, qs, axis=1)):
                sim[f"{name}_q{round(100 * q):02d}"] = col
        payday = pay.reset_index().rename(columns={"index": "customer_id"})
        payday.insert(0, "customer_id", payday.pop("customer_id"))
        season_rows = pd.DataFrame([(l, m, f) for l, d in sorted(season.items()) for m, f in sorted(d.items())],
                                   columns=["line", "month_of_year", "factor"])
        priors = pd.concat([statfin_spend.assign(kind="spending_eur_month"),
                            statfin_income.assign(line="income", kind="income_eur_month")], ignore_index=True)
        settings = {k: getattr(C, k) for k in dir(C) if k.isupper() and isinstance(getattr(C, k), (int, float, str))}
        settings.update({"CPI_FACTOR": cpi, "N_COMPLETE_MONTHS": len(months), "FIRST_MONTH": str(first.date()),
                         "LAST_MONTH": str(last.date()), "AS_OF": str(as_of.date()),
                         **{f"PAYDAY_{k.upper()}": v for k, v in pay.attrs["prior"].items()}})
        config = pd.DataFrame({"setting": list(settings), "value": [str(v) for v in settings.values()]})
        extra = [("customer_monthly_model", mon), ("customer_payday", payday), ("customer_simulation", sim),
                 ("model_season", season_rows), ("statfin_priors", priors), ("model_config", config)]
        if trend_null is not None:
            extra.append(("model_trend_null", trend_null))
        for name, df in [("model_hyper", hyper), ("customer_line", customer_line), ("customer_summary", summary)] + extra:
            con.register("tmp_df", df)
            con.sql(f"create or replace table {name} as select * from tmp_df")
            con.unregister("tmp_df")
    con.close()
    if verbose:
        print(f"model run in {time.time() - t0:.1f}s  (as_of {as_of.date()}, {len(months)} complete months, "
              f"CPI factor {cpi:.3f})")
    return hyper, customer_line, summary


if __name__ == "__main__":
    hyper, cl, summ = run()
    pd.set_option("display.width", 200)
    print("\nStatistics Finland weight on peer-group level (mean over groups):")
    print(hyper.groupby("line")["statfin_weight"].mean().round(4).to_string())
    print("\nsummary quantiles:")
    print(summ[["income_month", "regular_month", "essentials_month", "discretionary_month", "shock_month",
                "savings_month", "balance", "safe_to_spend_week", "safe_to_save_month", "surprise_fund",
                "shocks_per_year"]]
          .describe(percentiles=[.1, .5, .9]).round(0).to_string())
