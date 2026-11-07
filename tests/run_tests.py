#!/usr/bin/env python3
"""Run every synthetic case through the rule engine and compare verdicts.

Run:  python3 tests/run_tests.py
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import checker            # noqa: E402
import xlsx_read          # noqa: E402
import json               # noqa: E402

CASES = os.path.join(HERE, "cases")


def load_template():
    with open(os.path.join(ROOT, "rules", "template.json"), encoding="utf-8") as fh:
        return json.load(fh)


def evaluate_file(path, template):
    try:
        workbook = xlsx_read.read_workbook(path)
    except xlsx_read.XlsxError as exc:
        return {"verdict": "critical",
                "counts": {"critical": 1, "error": 0, "warning": 0},
                "findings": [{"severity": "critical", "problem": str(exc)}]}
    return checker.evaluate(workbook, template)


def main():
    template = load_template()
    expected = {}
    with open(os.path.join(CASES, "expected.txt"), encoding="utf-8") as fh:
        for line in fh:
            name, verdict = line.strip().split("\t")
            expected[name] = verdict

    passed = failed = 0
    for name in sorted(expected):
        path = os.path.join(CASES, name)
        if not os.path.exists(path):
            print(f"FAIL {name}: файл відсутній")
            failed += 1
            continue
        result = evaluate_file(path, template)
        want = expected[name]
        got = result["verdict"]
        ok = got == want
        mark = "OK  " if ok else "FAIL"
        counts = result["counts"]
        detail = f"{counts['critical']}/{counts['error']}/{counts['warning']}"
        print(f"{mark} {name:24s} очікували {want:8s} отримали {got:8s} "
              f"(к/п/п {detail})")
        if ok:
            passed += 1
        else:
            failed += 1
            for f in result["findings"][:4]:
                print(f"       · {f['severity']}: {f['problem']}")

    print(f"\nПройдено {passed} із {passed + failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())