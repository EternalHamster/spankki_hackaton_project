"""Statistics Finland (StatFin PxWeb API) benchmarks used as priors.

Sources (open data, CC BY 4.0, Statistics Finland):
  ktutk/14q4  Household consumption expenditure by age of reference person, 2022,
              EUR per consumption unit per month (current prices)
  tjt/11py    Personal disposable monetary income by single year of age, 2024 (mean, EUR/year)
  khi/11xc    Consumer price index 2015=100, used to lift 2022 spending to the data period

Results are cached as CSV in BDA/data/statfin/ so the pipeline also runs offline.
Run `python -m engine.statfin --refresh` to re-download.
"""
import sys
import pandas as pd
import requests

from .config import STATFIN_DIR, AGE_BANDS

API = "https://pxdata.stat.fi/PxWeb/api/v1/en/StatFin/"
CONSUMPTION_YEAR = "2022"
INCOME_YEAR = "2024"
PRICE_YEAR = "2025"   # data covers Oct 2024 - Sep 2026; latest annual CPI available

# Spending line -> COICOP 2018 codes in table 14q4 (summed). Lines without a clean match get no prior.
LINE_COICOP = {
    "groceries":        ["01"],
    "restaurants":      ["11111"],          # full-service restaurants & cafés
    "fast_food":        ["11112"],          # limited-service restaurants
    "taxi":             ["07322"],
    "public_transport": ["0731", "07321"],  # rail/tram/metro + bus
    "fuel":             ["0722"],
    "parking":          ["07241"],
    "entertainment":    ["094", "096"],     # recreational + cultural services
    "lifestyle":        ["03", "131"],      # clothing & footwear + personal care
    "travel":           ["098", "112", "0733"],  # package holidays, accommodation, flights
    "health":           ["061"],            # medicines & health products
    "home_tech":        ["05", "081"],      # furnishings/household + ICT equipment
    "housing":          ["041", "04441", "04631"],  # rent + maintenance charge + mortgage interest
    "utilities":        ["0441", "0442", "0443", "045", "083"],  # water, waste, sewage, energy, telecom
}
CONS_AGE = {"17-24": ["17-24"], "25-34": ["25-34"], "35-44": ["35-44"], "45-54": ["45-54"],
            "55-64": ["55-64"], "65-74": ["65-74"], "75+": ["75-84", "85-"]}


def _query(table, selections, fmt="json"):
    body = {"query": [{"code": c, "selection": {"filter": "item", "values": v}} for c, v in selections.items()],
            "response": {"format": fmt}}
    r = requests.post(API + table, json=body, timeout=60)
    r.raise_for_status()
    return r.json()


def _num(val):
    try:
        return float(val)
    except ValueError:          # StatFin uses ".", "..", "..." for missing / confidential
        return None


def _rows(js):
    """Long format: one row per key combination and content measure (column 'contentscode')."""
    keys = [c["code"] for c in js["columns"] if c["type"] != "c"]
    measures = [c["code"] for c in js["columns"] if c["type"] == "c"]
    out = []
    for d in js["data"]:
        for m, val in zip(measures, d["values"]):
            out.append(dict(zip(keys, d["key"]), contentscode=m, value=_num(val)))
    return pd.DataFrame(out)


def download():
    STATFIN_DIR.mkdir(parents=True, exist_ok=True)
    codes = sorted({c for v in LINE_COICOP.values() for c in v} | {"0"})
    ages = sorted({a for v in CONS_AGE.values() for a in v})
    cons = _rows(_query("ktutk/14q4.px", {"timeperiod_y": [CONSUMPTION_YEAR],
                                           "coicop_46_20231201": codes,
                                           "ikaryhma_10_20180101": ages,
                                           "contentscode": ["kulukk_kt_hk_2_1"]}))
    cons = cons.rename(columns={"coicop_46_20231201": "coicop", "ikaryhma_10_20180101": "statfin_age",
                                "value": "eur_month_per_cu"})[["statfin_age", "coicop", "eur_month_per_cu"]]
    cons.to_csv(STATFIN_DIR / "consumption_by_age_2022.csv", index=False)

    single_ages = [f"{a:03d}" for a in range(17, 90)] + ["90-"]
    inc = _rows(_query("tjt/11py.px", {"ikaryhma_22_20191201": single_ages,
                                       "contentscode": ["hkturaha_mean", "tjt-henkiloita"],
                                       "timeperiod_y": [INCOME_YEAR], "sukupuoli_9_20180101": ["SSS"]}))
    inc = inc.pivot_table(index="ikaryhma_22_20191201", columns="contentscode", values="value").reset_index()
    inc.columns = ["age", "mean_disp_income_year", "persons"]
    inc["age"] = inc["age"].str.replace("-", "").astype(int)
    inc.to_csv(STATFIN_DIR / "income_by_age_2024.csv", index=False)

    cpi = _rows(_query("khi/11xc.px", {"timeperiod_y": [CONSUMPTION_YEAR, PRICE_YEAR],
                                       "coicop_38_20160101": ["0"], "contentscode": ["indeksipisteluku"]}))
    cpi.to_csv(STATFIN_DIR / "cpi.csv", index=False)
    print(f"StatFin data saved to {STATFIN_DIR}")


def _band(age):
    for lo, hi, name in AGE_BANDS:
        if lo <= age <= hi:
            return name
    return None


def load_priors():
    """Return (spend, income, cpi_factor).

    spend:  age_band, line, eur_month   (StatFin mean per consumption unit, lifted to PRICE_YEAR)
    income: age_band, eur_month          (population-weighted mean personal disposable income)
    """
    files = [STATFIN_DIR / f for f in ("consumption_by_age_2022.csv", "income_by_age_2024.csv", "cpi.csv")]
    if not all(f.exists() for f in files):
        download()
    cons = pd.read_csv(files[0], dtype={"coicop": str})
    inc = pd.read_csv(files[1])
    cpi = pd.read_csv(files[2]).sort_values("timeperiod_y")
    cpi_factor = float(cpi["value"].iloc[-1] / cpi["value"].iloc[0])

    # 75+ = simple mean of 75-84 and 85- (85+ is a small group)
    rows = []
    for band, statfin_ages in CONS_AGE.items():
        sub = cons[cons["statfin_age"].isin(statfin_ages)]
        for line, codes in LINE_COICOP.items():
            v = sub[sub["coicop"].isin(codes)].groupby("statfin_age")["eur_month_per_cu"].sum().mean()
            rows.append((band, line, v * cpi_factor))
    spend = pd.DataFrame(rows, columns=["age_band", "line", "eur_month"])

    inc["age_band"] = inc["age"].map(_band)
    inc = inc.dropna(subset=["age_band"])
    income = (inc.assign(w=inc["mean_disp_income_year"] * inc["persons"])
                 .groupby("age_band").apply(lambda d: d["w"].sum() / d["persons"].sum() / 12, include_groups=False)
                 .rename("eur_month").reset_index())
    return spend, income, cpi_factor


if __name__ == "__main__":
    if "--refresh" in sys.argv or not (STATFIN_DIR / "cpi.csv").exists():
        download()
    s, i, f = load_priors()
    print(f"CPI factor {CONSUMPTION_YEAR}->{PRICE_YEAR}: {f:.3f}")
    print(s.pivot(index="line", columns="age_band", values="eur_month").round(0).to_string())
    print(i.round(0).to_string())
