"""Prepare Finnish insight cards and server-only context for the configured public synthetic demo customer.

Run with the project Python environment and ANTHROPIC_API_KEY set: python scripts/prepare_insights.py --live
Makes one model request per customer (one retry if number verification fails). Never runs on page loads.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(REPO), str(REPO / "backend/src")]
from coach_context.insight_context import InsightSource, build_insight_context, render_insight_context
from money_coach.client import create_client
from money_coach.insights import InsightError, InsightWriter


class FinnishWriter(InsightWriter):
    def request(self, context):
        request = super().request(context)
        request["system"][0]["text"] += (
            "\nFor this Finnish demo, write all four fields in Finnish, overriding the English instruction. "
            "Keep numeric strings exactly as written in the context, including comma thousands separators. "
            "Do not convert annual frequency into a monthly frequency or invent new figures. "
            "Describe amounts as model estimates, not actual spending in the selected calendar month. "
            "Do not invent spending targets or claim a rising trend without explicit trend evidence. "
            "Peer figures are group statistics only; never describe an individual peer. "
            "Headlines and actions must be short and concrete. Use plain text, no Markdown."
            " Return exactly 3 insights. Each title must be at most 60 characters, headline_number 50 characters, "
            "explanation 850 characters (2-3 short sentences), and action 200 characters."
        )
        request["thinking"] = {"type": "disabled"}
        request["output_config"].pop("effort", None)
        return request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--customer", default="CUST00207", choices=["CUST00207", "CUST00127", "CUST00103"])
    parser.add_argument("--live", action="store_true", help="Authorize the model calls to generate cards")
    args = parser.parse_args()
    if not args.live:
        parser.error("Use --live to explicitly generate the demo cards with Claude.")
    demo = json.loads((REPO / "ui-demos/server-data/demo-data.json").read_text(encoding="utf-8"))
    source = InsightSource()
    bundle = {"schema_version": 1, "as_of": demo["summary"]["to"], "profiles": {}}
    client = create_client(max_retries=0)
    if client is None:
        raise SystemExit("Set ANTHROPIC_API_KEY before generating insights.")
    with client:
        original_create = client.messages.create
        last_response = None
        def capture(**kwargs):
            nonlocal last_response
            last_response = original_create(**kwargs)
            return last_response
        client.messages.create = capture
        writer = FinnishWriter(client, max_tokens=3000, live=True)
        for profile in demo["profiles"]:
            if profile["customer_id"] != args.customer:
                continue
            cid = profile["customer_id"]
            context = render_insight_context(build_insight_context(cid, source))
            result = None
            for attempt in range(2):
                try:
                    result = writer.run(context)
                    if all(row["numbers_verified"] for row in result["insights"]):
                        break
                    print(f"Number verification failed for {cid}, attempt {attempt + 1}.", flush=True)
                except InsightError as exc:
                    print(f"Validation failed for {cid}: {exc}", flush=True)
                    if last_response:
                        for block in last_response.content:
                            if block.type == 'text':
                                try:
                                    rows = json.loads(block.text).get('insights', [])
                                    print(json.dumps({'field_lengths': [{k: len(str(v)) for k, v in row.items()} for row in rows]}), flush=True)
                                except (ValueError, AttributeError):
                                    pass
            if not result or not all(row["numbers_verified"] for row in result["insights"]):
                raise SystemExit(f"No verified insights for {cid}; existing output is unchanged.")
            insights = [{"id": f"insight-{i + 1}", **row} for i, row in enumerate(result["insights"])]
            bundle["profiles"][cid] = {"context": context, "context_sha256": hashlib.sha256(context.encode()).hexdigest(),
                                       "model": result["model"], "insights": insights}
            print(json.dumps({"customer": cid, "verified_insights": len(insights), "usage": result["usage"]}), flush=True)
    target = REPO / "ui-demos/server-data/insights.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(target)
    print("Prepared verified insight cards for the configured public demo customer.")


if __name__ == "__main__":
    main()
