#!/usr/bin/env python3
"""Генератор синтетичних файлів за шаблоном v1.3 (лише для тестів).

Будує .xlsx з аркушами «Розрахунок» (шапка D3:D9, таблиця з рядка 12)
і «Довідники» (групи, в/ч, посади, звання, ПУ).

Run:  python3 tests/make_cases.py
"""

import os
import sys
import zipfile
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "cases")

COLUMNS = [
    ("A", "№ з/п"),
    ("B", "в/ч"),
    ("C", "Група"),
    ("D", "Тип групи (авто)"),
    ("E", "Посада"),
    ("F", "Військове звання"),
    ("G", "Прізвище, ім'я, по батькові"),
    ("H", "Примітка"),
    ("I", "Контроль"),
]

HEADER_LABELS = [
    ("B3", "Версія форми"), ("B4", "ПУ (відправник)"),
    ("B5", "Доба: дата початку (ДД.ММ.РРРР)"), ("B6", "Початок доби"),
    ("B7", "Кінець доби"), ("B8", "Відповідальна особа: звання"),
    ("B9", "Відповідальна особа: ПІБ"),
]

GROUPS = [("ПУ", "ПУ"), ("МВГ1", "МВГ"), ("МВГ2", "МВГ"),
          ("ВГ1", "ВГ"), ("Екіпаж 1", "Екіпаж")]
VCH = ["А0001", "А0002", "А0003"]
UNITS = ["ПУ 1", "ПУ 2"]
POSITIONS = ["Начальник ПУ", "Черговий ПУ", "Командир МВГ", "Кулеметник МВГ",
             "Водій-кулеметник", "Командир ВГ", "Оператор", "Механік",
             "Бойовий медик", "Сапер"]
RANKS = ["Солдат", "Старший солдат", "Молодший сержант", "Сержант",
         "Старший сержант", "Головний сержант", "Лейтенант", "Капітан", "Майор"]


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


def sheet_xml(cells, max_row=None, max_col=8):
    rows = {}
    for ref, value in cells.items():
        letters = "".join(ch for ch in ref if ch.isalpha())
        number = int("".join(ch for ch in ref if ch.isdigit()))
        rows.setdefault(number, {})[letters] = value

    limit = max_row or (max(rows) if rows else 1)
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
           '<worksheet xmlns="http://schemas.openxmlformats.org/'
           'spreadsheetml/2006/main">', "<sheetData>"]
    for r in range(1, limit + 1):
        row = rows.get(r)
        if not row:
            continue
        cells_xml = "".join(
            cell_xml(f"{letters}{r}", value)
            for letters, value in sorted(row.items(),
                                         key=lambda kv: (len(kv[0]), kv[0])))
        out.append(f'<row r="{r}">{cells_xml}</row>')
    out.append("</sheetData></worksheet>")
    return "".join(out)


def dictionaries_cells(groups=None, vch=None, units=None):
    groups = groups or GROUPS
    vch = vch or VCH
    units = units or UNITS
    cells = {
        "A1": "Група", "B1": "Тип групи (ПУ / МВГ / ВГ / Екіпаж)",
        "C1": "в/ч", "D1": "Посади", "E1": "Звання",
        "F1": "ПУ (відправники)", "H1": "Параметри",
        "H2": "Година початку доби", "I2": 0.375,
    }
    for i, (group, gtype) in enumerate(groups, start=2):
        cells[f"A{i}"] = group
        cells[f"B{i}"] = gtype
    for i, code in enumerate(vch, start=2):
        cells[f"C{i}"] = code
    for i, unit in enumerate(units, start=2):
        cells[f"F{i}"] = unit
    for i, pos in enumerate(POSITIONS, start=2):
        cells[f"D{i}"] = pos
    for i, rank in enumerate(RANKS, start=2):
        cells[f"E{i}"] = rank
    return cells


def report_cells(header, rows, extra=None):
    cells = {
        "A1": "ЩОДЕННИЙ РОЗРАХУНОК ОСОБОВОГО СКЛАДУ",
        "H3": "", "F3": "Усього осіб",
    }
    for ref, label in HEADER_LABELS:
        cells[ref] = label
    for i, (letter, title) in enumerate(COLUMNS):
        cells[f"{letter}11"] = title

    cells["D3"] = header.get("version", "1.3")
    cells["D4"] = header.get("sender", "ПУ 1")
    cells["D5"] = header.get("day", "05.11.2026")
    cells["D6"] = header.get("period_from", "05.11.2026 09:00")
    cells["D7"] = header.get("period_to", "06.11.2026 09:00")
    cells["D8"] = header.get("resp_rank", "Майор")
    cells["D9"] = header.get("resp_name", "КОМАНДИРОВ Петро Іванович")

    for i, row in enumerate(rows):
        r = 12 + i
        if row.get("n") is not None:
            cells[f"A{r}"] = row["n"]
        else:
            cells[f"A{r}"] = i + 1
        for key, letter in [("vch", "B"), ("group", "C"), ("type", "D"),
                            ("position", "E"), ("rank", "F"), ("name", "G"),
                            ("note", "H"), ("control", "I")]:
            if row.get(key) is not None:
                cells[f"{letter}{r}"] = row[key]

    for ref, value in (extra or {}).items():
        cells[ref] = value
    return cells


def write_xlsx(path, sheets):
    """sheets: [(name, cells_dict, max_row)]"""
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

        names = "".join(
            f'<sheet name="{escape(name)}" sheetId="{i}" r:id="rId{i}"/>'
            for i, (name, _, _) in enumerate(sheets, start=1))
        defined = (
            '<definedNames>'
            "<definedName name=\"f_version\">'Розрахунок'!$D$3</definedName>"
            "<definedName name=\"f_sender\">'Розрахунок'!$D$4</definedName>"
            "<definedName name=\"f_day\">'Розрахунок'!$D$5</definedName>"
            "<definedName name=\"f_period_from\">'Розрахунок'!$D$6</definedName>"
            "<definedName name=\"f_period_to\">'Розрахунок'!$D$7</definedName>"
            "<definedName name=\"f_resp_rank\">'Розрахунок'!$D$8</definedName>"
            "<definedName name=\"f_resp_name\">'Розрахунок'!$D$9</definedName>"
            "</definedNames>")
        zf.writestr("xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f"<sheets>{names}</sheets>{defined}</workbook>")

        rels = "".join(
            f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>'
            for i in range(1, len(sheets) + 1))
        zf.writestr("xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f"{rels}</Relationships>")

        for i, (_, cells, max_row) in enumerate(sheets, start=1):
            zf.writestr(f"xl/worksheets/sheet{i}.xml",
                        sheet_xml(cells, max_row=max_row))


def good_rows():
    return [
        {"vch": "А0001", "group": "ПУ", "position": "Начальник ПУ",
         "rank": "Майор", "name": "ПЕТРЕНКО Іван Олегович"},
        {"vch": "А0001", "group": "ПУ", "position": "Черговий ПУ",
         "rank": "Капітан", "name": "СИДОРЕНКО Олег Петрович"},
        {"vch": "А0002", "group": "МВГ1", "position": "Командир МВГ",
         "rank": "Лейтенант", "name": "КОВАЛЬЧУК Андрій Іванович"},
        {"vch": "А0002", "group": "МВГ1", "position": "Кулеметник МВГ",
         "rank": "Солдат", "name": "ШЕВЧЕНКО Микола Васильович"},
        {"vch": "А0003", "group": "ВГ1", "position": "Командир ВГ",
         "rank": "Сержант", "name": "БОНДАРЕНКО Сергій Миколайович"},
    ]


def cases():
    """(ім'я файлу, очікуваний вердикт, header, rows, extra cells, dict overrides)"""
    good = good_rows()
    out = []

    out.append(("T01_good.xlsx", "ok", {}, good, None, None))

    out.append(("T02_no_header.xlsx", "error",
                {"sender": None, "day": None}, good, None, None))

    out.append(("T03_unknown_unit.xlsx", "error",
                {"sender": "ПУ 9"}, good, None, None))

    out.append(("T04_future_day.xlsx", "error",
                {"day": "15.12.2026"}, good, None, None))

    out.append(("T06_empty_fields.xlsx", "error", {}, [
        dict(good[0], position=None),
        good[1], good[2], good[3], good[4],
    ], None, None))

    out.append(("T07_unknown_group.xlsx", "error", {}, [
        dict(good[0], group="МВГ9"),
        good[1], good[2], good[3], good[4],
    ], None, None))

    out.append(("T08_unknown_vch_position.xlsx", "warning", {}, [
        dict(good[0], vch="А9999", position="Повар"),
        good[1], good[2], good[3], good[4],
    ], None, None))

    out.append(("T09_bad_name.xlsx", "error", {}, [
        dict(good[0], name="Петренко Іван"),
        good[1], good[2], good[3], good[4],
    ], None, None))

    out.append(("T11_duplicate_name.xlsx", "error", {}, [
        good[0], dict(good[1], name=good[0]["name"]),
        good[2], good[3], good[4],
    ], None, None))

    out.append(("T17_empty_rows.xlsx", "warning", {}, [
        good[0], good[1], {"vch": None, "group": None, "position": None,
                           "rank": None, "name": None},
        good[2], good[3], good[4],
    ], None, None))

    out.append(("T18_empty_list.xlsx", "critical", {}, [], None, None))

    return out


def build():
    os.makedirs(OUT, exist_ok=True)
    expected = []
    for name, verdict, header, rows, extra, _ in cases():
        cells = report_cells(header, rows, extra)
        write_xlsx(os.path.join(OUT, name), [
            ("Розрахунок", cells, 311),
            ("Довідники", dictionaries_cells(), 200),
        ])
        expected.append((name, verdict))
        print(f"{name:32s} очікується: {verdict}")

    with open(os.path.join(OUT, "expected.txt"), "w", encoding="utf-8") as fh:
        for name, verdict in expected:
            fh.write(f"{name}\t{verdict}\n")
    print(f"\nЗгенеровано {len(expected)} файлів у {OUT}")


if __name__ == "__main__":
    build()