"""Generate Markdown summary + Bug report from the UAT workbook's current state."""
import os, datetime
from collections import Counter, defaultdict
from openpyxl import load_workbook

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
XLSX = os.path.join(ROOT, "..", "UAT_Checklist_Bakso_Mas_Sular.xlsx")
OUT = os.path.join(ROOT, "reports")
MODULE_SHEETS = ["Authentication", "Customer Frontend", "Admin Panel",
                 "Payment Flow", "Order Flow", "Shipping Flow", "Security"]
SEV = {"Critical": "Critical", "High": "High", "Medium": "Medium", "Low": "Low"}

def rows():
    wb = load_workbook(XLSX, read_only=True)
    for name in MODULE_SHEETS:
        ws = wb[name]
        for r in ws.iter_rows(min_row=2, values_only=True):
            if r and r[0]:
                yield {"id": r[0], "module": r[1], "scenario": r[2], "pre": r[3],
                       "steps": r[4], "expected": r[5], "priority": r[6],
                       "status": r[7] or "Not Run", "notes": r[9] or ""}

def main():
    os.makedirs(OUT, exist_ok=True)
    data = list(rows())
    total = len(data)
    c = Counter(x["status"] for x in data)
    passed, failed, blocked = c.get("Pass", 0), c.get("Fail", 0), c.get("Blocked", 0)
    executed = passed + failed
    rate = f"{(passed / executed * 100):.1f}%" if executed else "N/A (0 executed)"
    ts = datetime.date.today().isoformat()

    by_mod = defaultdict(Counter)
    for x in data:
        by_mod[x["module"] if False else x["id"].split("-")[0]][x["status"]] += 1

    md = [f"# UAT Execution Summary — Bakso Mas Sular\n",
          f"_Generated: {ts} · Tester: Claude Code_\n",
          "| Metric | Value |", "|---|---|",
          f"| Total Test Cases | {total} |",
          f"| Passed | {passed} |", f"| Failed | {failed} |",
          f"| Blocked | {blocked} |", f"| Executed | {executed} |",
          f"| Pass Rate | {rate} |", ""]
    md.append("## By module\n")
    md.append("| Module | Pass | Fail | Blocked |")
    md.append("|---|---|---|---|")
    names = {"AUTH":"Authentication","CF":"Customer Frontend","ADM":"Admin Panel",
             "PAY":"Payment Flow","ORD":"Order Flow","SHP":"Shipping Flow","SEC":"Security"}
    for k, label in names.items():
        cc = by_mod[k]
        md.append(f"| {label} | {cc.get('Pass',0)} | {cc.get('Fail',0)} | {cc.get('Blocked',0)} |")
    fails = [x for x in data if x["status"] == "Fail"]
    md.append("\n## Failed cases by module\n")
    if not fails:
        md.append("_No FAIL results recorded._")
        if executed == 0:
            md.append("\n> ⚠️ **0 test cases executed.** All cases Blocked — execution "
                      "environment lacks Docker/DB so the backend cannot boot. The Playwright "
                      "harness is authored and compiles; run it where a stack is reachable.")
    else:
        bymod = defaultdict(list)
        for x in fails: bymod[x["module"]].append(x)
        for mod, items in bymod.items():
            md.append(f"### {mod}")
            for x in items:
                md.append(f"- **{x['id']}** — {x['scenario']}: {x['notes']}")
    open(os.path.join(OUT, "UAT_Summary.md"), "w", encoding="utf-8").write("\n".join(md))

    # Bug report (one entry per FAIL)
    bug = [f"# Bug Report — Bakso Mas Sular UAT\n", f"_Generated: {ts}_\n"]
    if not fails:
        bug.append("_No defects logged (0 FAIL results)._\n")
        if executed == 0:
            bug.append("All 92 cases are **Blocked** pending an executable environment "
                       "(Docker + MySQL/Redis/RabbitMQ + seed). Not defects.")
    for x in fails:
        bug += [f"## {x['id']} — {x['module']}",
                f"- **Scenario:** {x['scenario']}",
                f"- **Severity:** {SEV.get(x['priority'],'Medium')}",
                f"- **Priority:** {x['priority']}",
                f"- **Steps:** {x['steps']}",
                f"- **Expected:** {x['expected']}",
                f"- **Actual:** {x['notes']}",
                f"- **Evidence:** e2e/reports/html (trace/screenshot/video)",
                f"- **Possible Cause:** see Notes / trace", ""]
    open(os.path.join(OUT, "Bug_Report.md"), "w", encoding="utf-8").write("\n".join(bug))
    print(f"summary+bug written; total={total} pass={passed} fail={failed} blocked={blocked} rate={rate}")

if __name__ == "__main__":
    main()
