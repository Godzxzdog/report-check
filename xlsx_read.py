#!/usr/bin/env python3
"""Minimal XLSX reader — standard library only.

Returns sheets as {"name": str, "rows": [[cell, ...], ...]} where cells are
strings, numbers, or None. Handles shared strings, inline strings, booleans and
numeric values. Formulas are read from their cached <v> value, so files saved by
Excel or LibreOffice work without recalculation.

This module deliberately ignores styling, merged cells and images: the checker
only needs cell coordinates and values.
"""

import re
import zipfile
import xml.etree.ElementTree as ET

NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pkg": "http://schemas.openxmlformats.org/package/2006/relationships",
}

CELL_REF = re.compile(r"^([A-Z]+)([0-9]+)$")


class XlsxError(Exception):
    """Raised when the file is not a readable XLSX workbook."""


def col_to_index(letters):
    """'A' -> 0, 'B' -> 1, 'AA' -> 26."""
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - ord("A") + 1)
    return n - 1


def index_to_col(idx):
    """0 -> 'A', 25 -> 'Z', 26 -> 'AA'."""
    letters = ""
    idx += 1
    while idx:
        idx, rem = divmod(idx - 1, 26)
        letters = chr(ord("A") + rem) + letters
    return letters


def _text(node):
    """Concatenate every <t> under a string node, skipping phonetic runs."""
    parts = []
    for t in node.iter():
        if t.tag.endswith("}t"):
            parts.append(t.text or "")
    return "".join(parts)


def _read_shared_strings(zf):
    try:
        raw = zf.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    root = ET.fromstring(raw)
    return [_text(si) for si in root.findall("main:si", NS)]


def _number(text):
    try:
        if re.fullmatch(r"-?\d+", text):
            return int(text)
        return float(text)
    except (TypeError, ValueError):
        return text


def _read_sheet(zf, path, shared):
    root = ET.fromstring(zf.read(path))
    rows = []
    for row in root.findall("main:sheetData/main:row", NS):
        cells = {}
        for c in row.findall("main:c", NS):
            ref = c.get("r") or ""
            m = CELL_REF.match(ref)
            if not m:
                continue
            idx = col_to_index(m.group(1))
            ctype = c.get("t")
            if ctype == "inlineStr":
                node = c.find("main:is", NS)
                value = _text(node) if node is not None else None
            else:
                v = c.find("main:v", NS)
                if v is None or v.text is None:
                    value = None
                elif ctype == "s":
                    pos = int(v.text)
                    value = shared[pos] if 0 <= pos < len(shared) else None
                elif ctype == "b":
                    value = v.text == "1"
                elif ctype in ("str", "e"):
                    value = v.text
                else:
                    value = _number(v.text)
            cells[idx] = value
        if cells:
            width = max(cells) + 1
            rows.append([cells.get(i) for i in range(width)])
        else:
            rows.append([])
    return rows


def _sheet_paths(zf):
    """Map sheet display name -> worksheet path inside the archive."""
    workbook = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    targets = {}
    for rel in rels.findall("pkg:Relationship", NS):
        targets[rel.get("Id")] = rel.get("Target")

    result = []
    for sheet in workbook.findall("main:sheets/main:sheet", NS):
        name = sheet.get("name")
        rid = sheet.get(f"{{{NS['rel']}}}id")
        target = targets.get(rid, "")
        if target.startswith("/xl/"):
            path = target[1:]
        elif target.startswith("xl/"):
            path = target
        else:
            path = "xl/" + target.lstrip("/")
        result.append((name, path))
    return result


def read_workbook(path):
    """Read an XLSX file into an ordered list of sheets.

    Each sheet is {"name": str, "rows": [[cell, ...], ...]}.
    Raises XlsxError when the file is missing, unreadable, or not a workbook.
    """
    try:
        with zipfile.ZipFile(path) as zf:
            names = set(zf.namelist())
            if "xl/workbook.xml" not in names:
                raise XlsxError("У файлі немає книги Excel (xl/workbook.xml)")
            shared = _read_shared_strings(zf)
            sheets = []
            for name, sheet_path in _sheet_paths(zf):
                if sheet_path not in names:
                    raise XlsxError(f"Аркуш «{name}» відсутній у файлі")
                sheets.append({"name": name,
                               "rows": _read_sheet(zf, sheet_path, shared)})
            return sheets
    except zipfile.BadZipFile:
        raise XlsxError("Файл пошкоджений або має формат, відмінний від XLSX")
    except ET.ParseError as exc:
        raise XlsxError(f"Пошкоджена внутрішня структура файлу: {exc}")
    except OSError as exc:
        raise XlsxError(f"Не вдалося прочитати файл: {exc}")