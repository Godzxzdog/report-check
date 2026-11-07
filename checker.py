#!/usr/bin/env python3
"""Rule engine: compare a parsed workbook against a template description.

Findings carry a severity, a sheet, an Excel-style location (row/column) and a
recommendation, which is everything the reviewer screen needs to point at the
exact place in the file.

Severity levels:
  critical — the file cannot be evaluated (unreadable, wrong shape, no sheets)
  error    — a rule about filling or consistency is broken
  warning  — suspicious but not necessarily wrong; needs a human look
"""

import datetime as dt
import re

SEVERITY_ORDER = {"critical": 0, "error": 1, "warning": 2}

DATE_RE = re.compile(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})$")
TRAILING_SPACE_RE = re.compile(r"^\s|\s$|  +")


def finding(severity, sheet, row, column, problem, recommendation, rule_id):
    return {
        "severity": severity,
        "sheet": sheet,
        "row": row,
        "column": column,
        "problem": problem,
        "recommendation": recommendation,
        "rule": rule_id,
    }


def is_blank(value):
    return value is None or (isinstance(value, str) and value.strip() == "")


def parse_date(value):
    """Accept a real date cell or a DD.MM.YYYY string. Returns date or None."""
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str):
        m = DATE_RE.match(value.strip())
        if m:
            day, month, year = (int(p) for p in m.groups())
            try:
                return dt.date(year, month, day)
            except ValueError:
                return None
    return None


def to_number(value):
    """Return a float for numeric cells and numeric strings, else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip().replace(",", ".")
        try:
            return float(text)
        except ValueError:
            return None
    return None


def _header_map(sheet_cfg, rows):
    """Map configured column index -> actual position in the header row."""
    header_row = int(sheet_cfg.get("header_row", 1)) - 1
    header = rows[header_row] if header_row < len(rows) else []
    normalized = {}
    for idx, cell in enumerate(header):
        if isinstance(cell, str):
            normalized.setdefault(cell.strip().lower(), idx)

    positions = {}
    for pos, col in enumerate(sheet_cfg.get("columns", [])):
        title = str(col.get("name", "")).strip().lower()
        if title in normalized:
            positions[pos] = normalized[title]
    return positions


def check_structure(workbook, template):
    """Verify sheets and headers. Returns (findings, per-sheet data)."""
    found = []
    by_name = {s["name"].strip().lower(): s for s in workbook}
    data = {}

    for sheet_cfg in template.get("sheets", []):
        name = sheet_cfg["name"]
        if sheet_cfg.get("required", True) and name.strip().lower() not in by_name:
            found.append(finding(
                "critical", name, None, None,
                f"Відсутній обов'язковий аркуш «{name}»",
                "Надайте файл за затвердженим шаблоном; аркуш не має бути "
                "перейменований або видалений",
                "sheet_missing"))
            continue

        sheet = by_name.get(name.strip().lower())
        if sheet is None:
            continue

        rows = sheet["rows"]
        header_row = int(sheet_cfg.get("header_row", 1))
        if len(rows) < header_row:
            found.append(finding(
                "critical", name, header_row, None,
                "Немає рядка заголовків",
                "Відновіть шапку таблиці згідно з шаблоном",
                "header_row_missing"))
            continue

        header = rows[header_row - 1]
        present = {c.strip().lower() for c in header if isinstance(c, str)}
        expected = [c for c in sheet_cfg.get("columns", []) if c.get("required")]
        for col in expected:
            title = str(col["name"]).strip()
            if title.lower() not in present:
                found.append(finding(
                    "critical", name, header_row, None,
                    f"Відсутній обов'язковий стовпець «{title}»",
                    "Відновіть назву стовпця точно як у шаблоні",
                    "column_missing"))

        if all(not f["sheet"] == name for f in found):
            data[name] = {
                "rows": rows,
                "positions": _header_map(sheet_cfg, rows),
                "start": int(sheet_cfg.get("data_start_row", header_row + 1)) - 1,
            }

    return found, data


def check_cells(sheet_name, sheet_cfg, rows, positions):
    """Validate every data cell against its column type and rules."""
    from xlsx_read import index_to_col

    found = []
    columns = sheet_cfg.get("columns", [])
    start = int(sheet_cfg.get("data_start_row", 2)) - 1

    for row_no in range(start, len(rows)):
        row = rows[row_no]
        excel_row = row_no + 1
        empty_row = True

        for pos, col in enumerate(columns):
            if pos not in positions:
                continue
            idx = positions[pos]
            value = row[idx] if idx < len(row) else None
            letter = index_to_col(idx)
            title = col["name"]
            where = f"{letter}{excel_row}"

            if is_blank(value):
                if col.get("required"):
                    found.append(finding(
                        "error", sheet_name, excel_row, title,
                        f"Порожнє обов'язкове поле «{title}» ({where})",
                        "Заповніть поле", "required_empty"))
                continue

            empty_row = False
            ctype = col.get("type", "text")

            if ctype == "number":
                num = to_number(value)
                if num is None:
                    found.append(finding(
                        "error", sheet_name, excel_row, title,
                        f"«{title}» ({where}) має бути числом, а містить "
                        f"{value!r}",
                        "Введіть числове значення без літер і пробілів",
                        "number_format"))
                    continue
                low = col.get("min")
                high = col.get("max")
                if low is not None and num < low:
                    found.append(finding(
                        "error", sheet_name, excel_row, title,
                        f"«{title}» ({where}) = {num:g}, менше за мінімум {low:g}",
                        f"Значення не може бути меншим за {low:g}",
                        "number_min"))
                if high is not None and num > high:
                    found.append(finding(
                        "error", sheet_name, excel_row, title,
                        f"«{title}» ({where}) = {num:g}, більше за максимум {high:g}",
                        f"Значення не може бути більшим за {high:g}",
                        "number_max"))

            elif ctype == "date":
                if parse_date(value) is None:
                    found.append(finding(
                        "error", sheet_name, excel_row, title,
                        f"«{title}» ({where}) не є датою у форматі ДД.ММ.РРРР: "
                        f"{value!r}",
                        "Введіть дату як 05.11.2026",
                        "date_format"))

            elif ctype == "text":
                text = str(value)
                limit = col.get("max_length")
                if limit and len(text) > limit:
                    found.append(finding(
                        "error", sheet_name, excel_row, title,
                        f"«{title}» ({where}) довше за {limit} символів",
                        "Скоротіть текст", "text_too_long"))
                if TRAILING_SPACE_RE.search(text):
                    found.append(finding(
                        "warning", sheet_name, excel_row, title,
                        f"«{title}» ({where}) містить зайві пробіли",
                        "Приберіть пробіли на початку, в кінці та подвійні "
                        "всередині", "text_spaces"))

        if empty_row and row_no > start:
            pass  # trailing blank rows are normal in Excel files
    return found


def _column_values(rows, cfg, positions, key):
    for pos, col in enumerate(cfg.get("columns", [])):
        if col.get("key") == key and pos in positions:
            idx = positions[pos]
            return [r[idx] if idx < len(r) else None for r in rows]
    return []


def check_rows(sheet_name, sheet_cfg, rows, positions):
    """Apply per-row cross-column assertions (row_checks in the template)."""
    from xlsx_read import index_to_col

    found = []
    start = int(sheet_cfg.get("data_start_row", 2)) - 1
    by_key = {c.get("key"): c for c in sheet_cfg.get("columns", [])}
    key_pos = {c.get("key"): pos for pos, c in
               enumerate(sheet_cfg.get("columns", []))}

    for check in sheet_cfg.get("row_checks", []):
        when = check.get("when", {})
        assert_ = check.get("assert", {})
        when_key = when.get("column")
        target_key = assert_.get("column")
        if when_key not in key_pos or target_key not in key_pos:
            continue
        w_pos, t_pos = key_pos[when_key], key_pos[target_key]
        if w_pos not in positions or t_pos not in positions:
            continue
        w_idx, t_idx = positions[w_pos], positions[t_pos]
        t_title = by_key[target_key]["name"]
        t_letter = index_to_col(t_idx)

        for row_no in range(start, len(rows)):
            row = rows[row_no]
            w_val = row[w_idx] if w_idx < len(row) else None
            if when.get("is") == "filled" and is_blank(w_val):
                continue
            t_val = row[t_idx] if t_idx < len(row) else None
            if is_blank(t_val):
                continue

            ok = True
            if "column_ref" in assert_:
                ref_pos = key_pos.get(assert_["column_ref"])
                if ref_pos is None or ref_pos not in positions:
                    continue
                r_idx = positions[ref_pos]
                r_val = row[r_idx] if r_idx < len(row) else None
                left, right = to_number(t_val), to_number(r_val)
                if left is None or right is None:
                    continue
            else:
                left, right = to_number(t_val), to_number(assert_.get("value"))
                if left is None or right is None:
                    continue

            op = assert_.get("op")
            ops = {
                "<=": left <= right, "<": left < right,
                ">=": left >= right, ">": left > right,
                "==": left == right, "!=": left != right,
                "~=": abs(left - right) <= float(assert_.get("tolerance", 0.001)),
            }
            ok = ops.get(op, True)
            if not ok:
                excel_row = row_no + 1
                found.append(finding(
                    "error", sheet_name, excel_row, t_title,
                    f"{check.get('description', 'Порушення правила')} "
                    f"({t_letter}{excel_row}: {left:g} {op} {right:g})",
                    "Виправте значення у рядку", check.get("id", "row_check")))
    return found


def check_uniques(sheet_name, sheet_cfg, rows, positions):
    """Flag repeated combinations declared in unique_by."""
    found = []
    keys = sheet_cfg.get("unique_by") or []
    if not keys:
        return found
    by_key = {c.get("key"): c for c in sheet_cfg.get("columns", [])}
    key_pos = {c.get("key"): pos for pos, c in
               enumerate(sheet_cfg.get("columns", []))}
    used = [k for k in keys if k in key_pos and key_pos[k] in positions]
    if len(used) != len(keys):
        return found
    indices = [positions[key_pos[k]] for k in used]
    start = int(sheet_cfg.get("data_start_row", 2)) - 1

    seen = {}
    for row_no in range(start, len(rows)):
        row = rows[row_no]
        values = tuple(row[i] if i < len(row) else None for i in indices)
        if all(is_blank(v) for v in values):
            continue
        signature = tuple(str(v).strip().lower() if isinstance(v, str) else v
                          for v in values)
        excel_row = row_no + 1
        if signature in seen:
            titles = ", ".join(by_key[k]["name"] for k in used)
            found.append(finding(
                "error", sheet_name, excel_row, titles,
                f"Дублікат запису ({titles}) — уже є в рядку {seen[signature]}",
                "Видаліть повтор або об'єднайте записи", "duplicate_row"))
        else:
            seen[signature] = excel_row
    return found


def check_totals(sheet_name, sheet_cfg, rows, positions):
    """Evaluate aggregate control relationships (totals in the template)."""
    from xlsx_read import index_to_col

    found = []
    key_pos = {c.get("key"): pos for pos, c in
               enumerate(sheet_cfg.get("columns", []))}
    by_key = {c.get("key"): c for c in sheet_cfg.get("columns", [])}
    start = int(sheet_cfg.get("data_start_row", 2)) - 1

    def collect(spec):
        if "ratio" in spec:
            a, b = spec["ratio"]
            if a not in key_pos or b not in key_pos:
                return None
            ia, ib = key_pos[a], key_pos[b]
            if ia not in positions or ib not in positions:
                return None
            ia, ib = positions[ia], positions[ib]
            pairs = []
            for row in rows[start:]:
                va = to_number(row[ia] if ia < len(row) else None)
                vb = to_number(row[ib] if ib < len(row) else None)
                if va is not None and vb:
                    pairs.append((va, vb))
            if not pairs:
                return None
            total_a = sum(p[0] for p in pairs)
            total_b = sum(p[1] for p in pairs)
            return total_a / total_b * float(spec.get("scale", 1))

        key = spec.get("column")
        if key not in key_pos or key_pos[key] not in positions:
            return None
        idx = positions[key_pos[key]]
        values = [to_number(r[idx] if idx < len(r) else None) for r in rows[start:]]
        values = [v for v in values if v is not None]
        if not values:
            return None
        agg = spec.get("agg", "sum")
        if agg == "sum":
            return sum(values)
        if agg == "avg":
            return sum(values) / len(values)
        if agg == "min":
            return min(values)
        if agg == "max":
            return max(values)
        if agg == "count":
            return float(len(values))
        return None

    for rule in sheet_cfg.get("totals", []):
        left = collect(rule.get("left", {}))
        right = collect(rule.get("right", {}))
        if left is None or right is None:
            continue
        op = rule.get("op", "==")
        tol = float(rule.get("tolerance", 0.001))
        ops = {
            "<=": left <= right + tol, "<": left < right - tol,
            ">=": left >= right - tol, ">": left > right + tol,
            "==": abs(left - right) <= tol,
            "~=": abs(left - right) <= tol,
        }
        if not ops.get(op, True):
            found.append(finding(
                "error", sheet_name, None, None,
                f"{rule.get('description', 'Порушення контрольного співвідношення')}: "
                f"отримано {left:g}, очікується {op} {right:g}",
                "Перевірте підсумкові показники проти деталізованих даних",
                rule.get("id", "totals")))
    return found


def evaluate(workbook, template):
    """Run every check. Returns a dict with findings and worst severity."""
    structure, data = check_structure(workbook, template)
    found = list(structure)

    for sheet_cfg in template.get("sheets", []):
        info = data.get(sheet_cfg["name"])
        if not info:
            continue
        name = sheet_cfg["name"]
        rows, positions = info["rows"], info["positions"]
        found += check_cells(name, sheet_cfg, rows, positions)
        found += check_rows(name, sheet_cfg, rows, positions)
        found += check_uniques(name, sheet_cfg, rows, positions)
        found += check_totals(name, sheet_cfg, rows, positions)

    counts = {"critical": 0, "error": 0, "warning": 0}
    for f in found:
        counts[f["severity"]] += 1

    if counts["critical"]:
        verdict = "critical"
    elif counts["error"]:
        verdict = "error"
    elif counts["warning"]:
        verdict = "warning"
    else:
        verdict = "ok"

    return {
        "verdict": verdict,
        "counts": counts,
        "findings": sorted(found, key=lambda f: (
            SEVERITY_ORDER[f["severity"]],
            f["sheet"] or "",
            f["row"] or 0)),
    }