"""Quick result plots -> BDA/output/plots/*.png      run: python -m engine.plots"""
import duckdb
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from . import config as C
from .insights import LABEL

OUT = C.OUTPUT_DIR / "plots"
# reference palette (light mode), fixed order
BLUE, ORANGE, AQUA = "#2a78d6", "#eb6834", "#1baf7a"
SURFACE, INK, INK2, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e6e5e0"
AGES = [b[2] for b in C.AGE_BANDS]

plt.rcParams.update({
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "axes.edgecolor": GRID, "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2,
    "text.color": INK, "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8,
    "axes.axisbelow": True, "axes.spines.top": False, "axes.spines.right": False,
    "font.size": 10, "axes.titlesize": 13, "axes.titleweight": "bold", "axes.titlelocation": "left",
})


def _save(fig, name):
    fig.tight_layout()
    fig.savefig(OUT / name, dpi=150)
    plt.close(fig)
    print("saved", OUT / name)


def baskets(s):
    """Median monthly € in the three baskets, by age band (stacked horizontal bars)."""
    s = s.assign(everyday=s["total_spend_month"] - s["regular_month"] - s["shock_month"])
    g = s.groupby("age_band")[["regular_month", "shock_month", "everyday"]].mean().reindex(AGES)
    fig, ax = plt.subplots(figsize=(8, 4.2))
    left = np.zeros(len(g))
    for col, color, name in [("regular_month", BLUE, "1 · Fixed bills"), ("shock_month", ORANGE, "2 · Surprises"),
                             ("everyday", AQUA, "3 · Everyday")]:
        ax.barh(g.index, g[col], left=left, color=color, height=0.6, label=name, edgecolor=SURFACE, linewidth=2)
        left += g[col].to_numpy()
    for y, tot in enumerate(left):
        ax.text(tot + 30, y, f"€{tot:,.0f}", va="center", color=INK2, fontsize=9)
    ax.invert_yaxis()
    ax.set_xlabel("average € per month")
    ax.set_title("Where the money goes: the three baskets by age")
    ax.grid(axis="y", visible=False)
    ax.set_xlim(0, left.max() * 1.12)
    ax.legend(loc="lower right", frameon=False, ncol=3, bbox_to_anchor=(1, -0.32))
    _save(fig, "1_baskets_by_age.png")


def vs_finland(cl):
    """Average €/month in this dataset vs Statistics Finland, ages 25-34, per line (dot plot)."""
    d = cl[cl["age_band"] == "25-34"].groupby("line")[["expected_month", "national_eur"]].mean().dropna()
    d = d[d["national_eur"] > 0].sort_values("expected_month")
    fig, ax = plt.subplots(figsize=(8, 5))
    y = np.arange(len(d))
    ax.hlines(y, d["national_eur"], d["expected_month"], color=GRID, linewidth=2)
    ax.scatter(d["national_eur"], y, color=ORANGE, s=60, zorder=3, label="Finland average (Statistics Finland)",
               edgecolor=SURFACE, linewidth=2)
    ax.scatter(d["expected_month"], y, color=BLUE, s=60, zorder=3, label="This dataset (model estimate)",
               edgecolor=SURFACE, linewidth=2)
    ax.set_yticks(y, [LABEL[l] for l in d.index])
    ax.set_xlabel("€ per month, age 25–34")
    ax.set_title("This dataset vs the Finnish average")
    ax.grid(axis="y", visible=False)
    ax.legend(loc="lower right", frameon=False)
    _save(fig, "2_dataset_vs_finland.png")


def validation(v):
    """Error reduction vs a plain average, new customers (3 months of history)."""
    d = v[(v["setting"].str.startswith("new")) & (v["line"] != "ALL LINES")].copy()
    d["pct"] = 100 * d["improvement"]
    d = d.sort_values("pct")
    overall = 100 * v[(v["setting"].str.startswith("new")) & (v["line"] == "ALL LINES")]["improvement"].iloc[0]
    fig, ax = plt.subplots(figsize=(8, 5))
    ax.barh([LABEL[l] for l in d["line"]], d["pct"], color=BLUE, height=0.6, edgecolor=SURFACE, linewidth=2)
    for y, p in enumerate(d["pct"]):
        if p >= 15 or y == 0:
            ax.text(p + 0.5, y, f"{p:.0f} %", va="center", color=INK2, fontsize=9)
    ax.axvline(overall, color=INK2, linewidth=1, linestyle="--")
    ax.text(overall + 0.4, len(d) - 0.6, f"all lines: {overall:.0f} %", color=INK2, fontsize=9)
    ax.set_xlabel("% smaller error than the customer's own average, with 3 months of data")
    ax.set_title("Accuracy gain for new customers")
    ax.grid(axis="y", visible=False)
    _save(fig, "3_validation_new_customers.png")


def safe_to_spend(s):
    """Distribution of safe-to-spend per week by age band (box plot)."""
    data = [s.loc[s["age_band"] == a, "safe_to_spend_week"].to_numpy() for a in AGES]
    fig, ax = plt.subplots(figsize=(8, 4.2))
    bp = ax.boxplot(data, tick_labels=AGES, patch_artist=True, widths=0.5, showfliers=False,
                    medianprops=dict(color=INK, linewidth=2), whiskerprops=dict(color=INK2),
                    capprops=dict(color=INK2))
    for b in bp["boxes"]:
        b.set(facecolor=BLUE, alpha=0.35, edgecolor=BLUE)
    for i, a in enumerate(data, 1):
        ax.text(i, np.median(a) + 12, f"€{np.median(a):.0f}", ha="center", color=INK, fontsize=9)
    tight = (s["safe_to_spend_week"] == 0).mean()
    ax.set_ylabel("€ per week")
    ax.set_xlabel("age")
    ax.set_title(f"Safe to spend this week ({100 * tight:.0f} % of customers have €0 until payday)")
    ax.grid(axis="x", visible=False)
    _save(fig, "4_safe_to_spend_by_age.png")


def insight_reach(ins):
    """Share of customers who get each kind of insight."""
    names = {"safe_to_spend": "Safe to spend", "surprise_fund": "Surprise fund", "baskets": "Three baskets",
             "savings": "Savings habit", "peer_gap": "Spends more than peers", "trend_down": "Spending dropped",
             "trend_up": "Spending rose", "unusual_payment": "Unusual payment"}
    d = (ins.groupby("kind")["customer_id"].nunique() / ins["customer_id"].nunique() * 100).sort_values()
    fig, ax = plt.subplots(figsize=(8, 4.2))
    ax.barh([names.get(k, k) for k in d.index], d, color=BLUE, height=0.6, edgecolor=SURFACE, linewidth=2)
    for y, p in enumerate(d):
        ax.text(p + 1, y, f"{p:.0f} %", va="center", color=INK2, fontsize=9)
    ax.set_xlim(0, 112)
    ax.set_xlabel("% of the 5,100 customers who get this insight")
    ax.set_title("What the coach tells people")
    ax.grid(axis="y", visible=False)
    _save(fig, "5_insight_reach.png")


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(C.DB_PATH), read_only=True)
    s = con.sql("select * from customer_summary").df()
    cl = con.sql("select * from customer_line").df()
    ins = con.sql("select customer_id, kind from insights").df()
    con.close()
    v = pd.read_csv(C.OUTPUT_DIR / "validation.csv")
    baskets(s)
    vs_finland(cl)
    validation(v)
    safe_to_spend(s)
    insight_reach(ins)


if __name__ == "__main__":
    run()
