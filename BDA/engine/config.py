"""Shared settings: paths, spending lines, baskets, peer groups, thresholds."""
from pathlib import Path

BDA = Path(__file__).resolve().parent.parent      # everything this engine creates lives under BDA/
PROJECT = BDA.parent
RAW = PROJECT / "Data"                            # the challenge's raw CSVs (read-only input, owned by the team)

STATFIN_DIR = BDA / "data" / "statfin"            # cached Statistics Finland tables (committed)
OUTPUT_DIR = BDA / "output"                       # all results
DB_PATH = OUTPUT_DIR / "coach.duckdb"             # full database the coach API reads (generated, gitignored)

TX_CSV = RAW / "tx_junction_transactions.csv"
CUSTOMERS_CSV = RAW / "tx_customers_junction.csv"
MTG_EVENTS_CSV = RAW / "mtg_negotiation_history.csv"
MTG_LINK_CSV = RAW / "mtg_tx_customer_link_and_final_mtg_infio.csv"

# Peer groups = age band x area. Age bands match Statistics Finland's household survey (table 14q4).
AGE_BANDS = [(17, 24, "17-24"), (25, 34, "25-34"), (35, 44, "35-44"), (45, 54, "45-54"),
             (55, 64, "55-64"), (65, 74, "65-74"), (75, 200, "75+")]
AREAS = {"00": "Helsinki", "01": "Vantaa", "02": "Espoo"}   # by first two postal digits (approximate)

# ---------------------------------------------------------------- spending lines
# Every transaction is mapped to exactly one line (see build_db.LINE_SQL).
# basket: 1 = mandatory & regular, 2 = mandatory & irregular (shocks), 3 = everyday, 0 = not spending
LINES = {
    # line               basket  essential  label (used in coach messages)
    "housing":          (1, True,  "rent / housing"),
    "utilities":        (1, True,  "bills & utilities"),
    "shock":            (2, True,  "unexpected costs (repairs, medical)"),
    "groceries":        (3, True,  "groceries"),
    "health":           (3, True,  "pharmacy & health"),
    "public_transport": (3, True,  "public transport"),
    "fuel":             (3, True,  "fuel"),
    "restaurants":      (3, False, "restaurants & cafés"),
    "fast_food":        (3, False, "fast food & takeaway"),
    "bars":             (3, False, "bars"),
    "taxi":             (3, False, "taxis"),
    "parking":          (3, False, "parking"),
    "transport_other":  (3, False, "other transport"),
    "entertainment":    (3, False, "entertainment"),
    "lifestyle":        (3, False, "shopping & personal care"),
    "travel":           (3, False, "travel"),
    "home_tech":        (3, False, "home & tech"),
    "big_purchase":     (3, False, "big one-off purchases"),
}
# Lines modelled with the hurdle-lognormal "everyday" model (monthly).
EVERYDAY_LINES = [k for k, v in LINES.items() if v[0] == 3 and k != "big_purchase"]
REGULAR_LINES = ["housing", "utilities"]
# Lines modelled as rare events (Gamma-Poisson count x lognormal size).
EVENT_LINES = ["shock", "big_purchase"]
DISCRETIONARY = [k for k, v in LINES.items() if v[0] == 3 and not v[1]]
ESSENTIAL_EVERYDAY = [k for k in EVERYDAY_LINES if LINES[k][1]]

# ---------------------------------------------------------------- thresholds
SHOCK_CATEGORIES = ("Health", "Home & Tech")              # big payment here = mandatory surprise
BIG_PURCHASE_CATEGORIES = ("Lifestyle", "Travel", "Entertainment")  # big payment here = discretionary one-off
EVENT_QUANTILE = 0.95        # payment above this category quantile counts as shock / big purchase
ANOMALY_CATEGORIES = ("Groceries", "Restaurants", "Transportation")
ANOMALY_EUR = 1000           # a >€1000 grocery/restaurant/transport payment is flagged, not modelled

# What the coach is allowed to say (uncertainty is used to decide, never shown)
TREND_MIN_PROB = 0.95        # P(level really changed) needed to mention a trend
TREND_MIN_REL = 0.20         # ... and at least a 20 % change
TREND_MIN_EUR = 20           # ... and at least €20 / month
TREND_RECENT_MONTHS = 6      # "recent" window compared with the earlier baseline
PEER_MIN_RATIO = 1.5         # mention peer gap only if >= 1.5x the peer median
PEER_MIN_EUR = 20            # ... and >= €20 / month above it
OVERSPEND_MIN_EUR = 50       # warn when spending exceeds income by more than this per month
SAFE_QUANTILE = 0.10         # safe-to-spend is the 10th percentile of simulated outcomes
SAFE_CUSHION_EUR = 100       # always keep this much on the account
N_SIM = 2000                 # Monte Carlo draws for safe-to-spend

# Prior strength of Statistics Finland on peer-group log-means (sd on the log scale; 0.5 ~ ±65 %)
STATFIN_PRIOR_SD = 0.5
SEED = 42
