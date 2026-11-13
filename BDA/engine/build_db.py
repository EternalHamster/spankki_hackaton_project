"""Build output/coach.duckdb from the raw CSVs in ../Data.

Tables
  transactions          raw rows + spend (positive €), line, basket, flags
  customers             age band, area, peer group, mortgage outcome (if any)
  customer_month_line   € and count per customer x month x line (all 24 months, zeros included)
  mtg_events, mtg_outcomes   mortgage tables as-is
  meta                  as_of date, thresholds used
"""
import time
import duckdb

from .config import (DB_PATH, TX_CSV, CUSTOMERS_CSV, MTG_EVENTS_CSV, MTG_LINK_CSV, AGE_BANDS, AREAS,
                     LINES, SHOCK_CATEGORIES, BIG_PURCHASE_CATEGORIES, EVENT_QUANTILE,
                     ANOMALY_CATEGORIES, ANOMALY_EUR)


def _in(values):
    return "(" + ",".join(f"'{v}'" for v in values) + ")"


AGE_SQL = "case " + " ".join(f"when customer_age between {lo} and {hi} then '{n}'" for lo, hi, n in AGE_BANDS) + " end"
AREA_SQL = "case " + " ".join(f"when substr(customer_postal_code,1,2)='{k}' then '{v}'" for k, v in AREAS.items()) + " else 'Other' end"
BASKET_SQL = "case line " + " ".join(f"when '{k}' then {v[0]}" for k, v in LINES.items()) + " else 0 end"

LINE_SQL = f"""
case
  when category in ('Salary','Other Income')                         then 'income'
  when category in ('Salary Sweep','Invest Deposit','Invest Withdraw') then 'savings_transfer'
  when category = 'Housing'                                          then 'housing'
  when category = 'Utilities'                                        then 'utilities'
  when category in {_in(ANOMALY_CATEGORIES)} and spend > {ANOMALY_EUR} then 'anomaly'
  when category in {_in(SHOCK_CATEGORIES)} and spend > thr           then 'shock'
  when category in {_in(BIG_PURCHASE_CATEGORIES)} and spend > thr    then 'big_purchase'
  when category = 'Groceries'                                        then 'groceries'
  when category = 'Restaurants' and mcc_code = '5814'                then 'fast_food'
  when category = 'Restaurants' and mcc_code = '5813'                then 'bars'
  when category = 'Restaurants'                                      then 'restaurants'
  when category = 'Transportation' and mcc_code = '4121'             then 'taxi'
  when category = 'Transportation' and mcc_code = '4111'             then 'public_transport'
  when category = 'Transportation' and mcc_code in ('5541','5542')   then 'fuel'
  when category = 'Transportation' and mcc_code = '7523'             then 'parking'
  when category = 'Transportation'                                   then 'transport_other'
  when category = 'Entertainment'                                    then 'entertainment'
  when category = 'Lifestyle'                                        then 'lifestyle'
  when category = 'Travel'                                           then 'travel'
  when category = 'Health'                                           then 'health'
  when category = 'Home & Tech'                                      then 'home_tech'
  else 'other'
end"""


def build(db_path=DB_PATH):
    t0 = time.time()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db_path.unlink(missing_ok=True)
    con = duckdb.connect(str(db_path))

    con.sql(f"""
      create table raw_tx as select * from read_csv('{TX_CSV.as_posix()}', header=true,
        types={{'customer_id':'VARCHAR','bank_account_id':'VARCHAR','mcc_code':'VARCHAR','merchant_id':'VARCHAR'}})""")

    # event thresholds: category-level quantile of purchase size
    con.sql(f"""
      create table thresholds as
      select category, quantile_cont(-tx_amount_eur, {EVENT_QUANTILE}) thr
      from raw_tx where transaction_type='purchase' group by 1""")

    con.sql(f"""
      create table transactions as
      with t as (
        select r.*, -r.tx_amount_eur as spend,
               strptime(r.tx_timestamp, '%d%b%y:%H:%M:%S') as ts,
               date_trunc('month', r.tx_date)::date as month,
               coalesce(h.thr, 1e12) as thr
        from raw_tx r left join thresholds h using (category))
      select * exclude (thr), {LINE_SQL} as line from t""")
    con.sql(f"alter table transactions add column basket integer")
    con.sql(f"update transactions set basket = {BASKET_SQL}")
    con.sql("drop table raw_tx")

    con.sql(f"""
      create table mtg_outcomes as select * from read_csv('{MTG_LINK_CSV.as_posix()}', header=true,
        types={{'customer_id':'VARCHAR','mortgage_customer_id':'VARCHAR'}})""")
    con.sql(f"""
      create table mtg_events as select * exclude (timestamp),
        strptime(timestamp, '%d%b%y:%H:%M:%S') as ts
      from read_csv('{MTG_EVENTS_CSV.as_posix()}', header=true, all_varchar=true)""")

    con.sql(f"""
      create table customers as
      select c.customer_id, c.customer_postal_code, c.customer_age,
             {AGE_SQL} as age_band, {AREA_SQL} as area,
             ({AGE_SQL}) || ' ' || ({AREA_SQL}) as peer_group,
             m.final_decision as mortgage_decision
      from read_csv('{CUSTOMERS_CSV.as_posix()}', header=true,
                    types={{'customer_id':'VARCHAR','customer_postal_code':'VARCHAR'}}) c
      left join mtg_outcomes m using (customer_id)""")

    # dense customer x month x line grid (zeros matter for the hurdle model)
    con.sql("""
      create table customer_month_line as
      with months as (select distinct month from transactions),
           lines  as (select distinct line from transactions where line not in ('other')),
           agg as (
             select customer_id, month, line,
                    count(*) as n_tx,
                    sum(case when line in ('income') then tx_amount_eur
                             when line = 'savings_transfer' then -tx_amount_eur
                             else spend end) as amount
             from transactions group by all)
      select c.customer_id, m.month, l.line,
             coalesce(a.n_tx, 0) as n_tx, coalesce(a.amount, 0.0) as amount
      from customers c cross join months m cross join lines l
      left join agg a on a.customer_id=c.customer_id and a.month=m.month and a.line=l.line""")

    con.sql(f"""
      create table meta as
      select (select max(tx_date) from transactions) as as_of,
             (select min(month) from transactions) as first_month,
             (select count(distinct month) from transactions) as n_months,
             {EVENT_QUANTILE} as event_quantile, {ANOMALY_EUR} as anomaly_eur""")

    print(con.sql("select line, basket, count(*) n, round(sum(spend)/5100/24,1) eur_per_cust_month "
                  "from transactions group by all order by basket, n desc").df().to_string())
    print(con.sql("select * from thresholds order by 1").df().round(1).to_string())
    print(con.sql("select * from meta").df().to_string())
    con.close()
    print(f"built {db_path} in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    build()
