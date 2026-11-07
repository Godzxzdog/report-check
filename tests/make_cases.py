#!/usr/bin/env python3
"""Build synthetic XLSX test files for the checker — standard library only.

Each case is (name, sheets, expected_verdict) where sheets is a list of
{"name": str, "rows": [[cell, ...], ...]}. Expected verdicts come from the
rules in rules/template.json.

Run:  python3 tests/make_cases.py
"""

import os
import sys
import zipfile
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "cases")

HEADER = ["Підрозділ", "Дата", "Кількість", "Виконано", "Відсоток", "Примітка"]

GOOD_ROWS = [
    ["Перший", "01.11.2026", 10, 8, 80, "без зауважень"],
    ["Другий", "02.11.2026", 20, 20, 100, ""],
]


def col_letters(idx):
    letters = ""
    idx += 1
    while idx:
        idx, rem = divmod(idx - 1, 26)
        letters = chr(ord("A") + rem) + letters
    return letters


def cell_xml(ref, value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return f'<c r="{ref}" t="b"><v>{1 if value else 0}</v></c>'
    if isinstance(value, (int, float)):
        return f'<c r="{ref}"><v>{value}</v></c>'
    text = escape(str(value))
    return (f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">'
            f"{text}</t></is></c>")


def sheet_xml(rows):
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
           "<sheetData>"]
    for r_idx, row in enumerate(rows, start=1):
        cells = "".join(cell_xml(f"{col_letters(c)}{r_idx}", v)
                        for c, v in enumerate(row))
        out.append(f'<row r="{r_idx}">{cells}</row>')
    out.append("</sheetData></worksheet>")
    return "".join(out)


def write_xlsx(path, sheets):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        overrides = "".join(
            f'<Override PartName="/xl/worksheets/sheet{i}.xml" '
            f'ContentType="application/vnd.openxmlformats-officedocument'
            f'.spreadsheetml.worksheet+xml"/>'
            for i in range(1, len(sheets) + 1))
        zf.writestr("[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            f"{overrides}</Types>")

        zf.writestr("_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>")

        sheet_entries = "".join(
            f'<sheet name="{escape(s["name"])}" sheetId="{i}" r:id="rId{i}"/>'
            for i, s in enumerate(sheets, start=1))
        zf.writestr("xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f"<sheets>{sheet_entries}</sheets></workbook>")

        rels = "".join(
            f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>'
            for i in range(1, len(sheets) + 1))
        zf.writestr("xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f"{rels}</Relationships>")

        for i, sheet in enumerate(sheets, start=1):
            zf.writestr(f"xl/worksheets/sheet{i}.xml", sheet_xml(sheet["rows"]))


def cases():
    """(filename, sheets, expected verdict) — all data is synthetic."""
    report = lambda rows: [{"name": "Звіт", "rows": [HEADER] + rows}]

    return [
        ("01_good.xlsx", report(GOOD_ROWS), "ok"),

        ("02_no_sheet.xlsx",
         [{"name": "Аркуш1", "rows": [HEADER] + GOOD_ROWS}], "critical"),

        ("03_bad_header.xlsx",
         [{"name": "Звіт", "rows": [["Підрозділ", "Дата", "К-сть",
                                     "Виконано", "Відсоток", "Примітка"]]
           + GOOD_ROWS}], "critical"),

        ("04_empty_required.xlsx",
         report([["Перший", "01.11.2026", None, 8, 80, ""]]), "error"),

        ("05_bad_dates.xlsx",
         report([["Перший", "2026-11-01", 10, 8, 80, ""],
                 ["Другий", "32.13.2026", 20, 20, 100, ""]]), "error"),

        ("06_bad_number.xlsx",
         report([["Перший", "01.11.2026", "десять", 8, 80, ""]]), "error"),

        ("07_duplicates.xlsx",
         report([["Перший", "01.11.2026", 10, 8, 80, ""],
                 ["Перший", "01.11.2026", 10, 8, 80, ""]]), "error"),

        ("08_bad_totals.xlsx",
         report([["Перший", "01.11.2026", 10, 20, 80, ""],
                 ["Другий", "02.11.2026", 20, 25, 100, ""]]), "error"),

        ("09_spaces.xlsx",
         report([["Перший  підрозділ ", "01.11.2026", 10, 8, 80, ""]]),
         "warning"),

        ("10_negative.xlsx",
         report([["Перший", "01.11.2026", -5, -1, -20, ""]]), "error"),
    ]


def broken_file(path):
    with open(path, "wb") as fh:
        fh.write(b"this is not a zip archive at all")


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = []
    for name, sheets, expected in cases():
        path = os.path.join(OUT, name)
        write_xlsx(path, sheets)
        manifest.append((name, expected))
        print(f"{name:24s} очікується: {expected}")

    broken = os.path.join(OUT, "11_broken.xlsx")
    broken_file(broken)
    manifest.append(("11_broken.xlsx", "critical"))
    print(f"{'11_broken.xlsx':24s} очікується: critical")

    with open(os.path.join(OUT, "expected.txt"), "w", encoding="utf-8") as fh:
        for name, expected in manifest:
            fh.write(f"{name}\t{expected}\n")
    print(f"\nЗгенеровано {len(manifest)} файлів у {OUT}")


if __name__ == "__main__":
    main()