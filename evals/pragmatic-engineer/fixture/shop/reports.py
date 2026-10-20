def summarize(orders):
    """Count and total the orders in each status, for the daily report."""
    summary = {}

    paid = [o for o in orders if o["status"] == "paid"]
    paid_total = 0
    for o in paid:
        paid_total += o["amount_cents"]
    summary["paid"] = {"count": len(paid), "total_cents": paid_total}

    refunded = [o for o in orders if o["status"] == "refunded"]
    refunded_total = 0
    for o in refunded:
        refunded_total += o["amount_cents"]
    summary["refunded"] = {"count": len(refunded), "total_cents": refunded_total}

    pending = [o for o in orders if o["status"] == "pending"]
    pending_total = 0
    for o in pending:
        pending_total += o["amount_cents"]
    summary["pending"] = {"count": len(pending), "total_cents": pending_total}

    return summary


def format_cents(cents):
    return "$%d.%02d" % (cents // 100, cents % 100)
