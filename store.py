#!/usr/bin/env python3
"""Storage layer for the report-check app: SQLite register + file store.

Everything lives in one directory tree so a backup is a single copy:

    storage/register.db      submissions, checks, status history, decisions
    storage/units/<unit>/    pristine copies of received files
    storage/backups/         automatic snapshots before risky operations

The register keeps the original file untouched forever: re-checking a file adds
a new check row and never rewrites the stored copy.
"""

import datetime as dt
import hashlib
import json
import os
import shutil
import sqlite3

BASE = os.path.dirname(os.path.abspath(__file__))
STORAGE = os.path.join(BASE, "storage")
DB_PATH = os.path.join(STORAGE, "register.db")
FILES = os.path.join(STORAGE, "units")
BACKUPS = os.path.join(STORAGE, "backups")

SCHEMA = """
CREATE TABLE IF NOT EXISTS submissions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    number        TEXT NOT NULL UNIQUE,
    unit          TEXT NOT NULL,
    filename      TEXT NOT NULL,
    stored_path   TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    sha256        TEXT NOT NULL,
    received_at   TEXT NOT NULL,
    uploaded_at   TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'new',
    user_comment  TEXT DEFAULT '',
    duplicate_of  INTEGER
);

CREATE TABLE IF NOT EXISTS checks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id  INTEGER NOT NULL REFERENCES submissions(id),
    run_at         TEXT NOT NULL,
    template_version TEXT NOT NULL,
    verdict        TEXT NOT NULL,
    critical_count INTEGER NOT NULL DEFAULT 0,
    error_count    INTEGER NOT NULL DEFAULT 0,
    warning_count  INTEGER NOT NULL DEFAULT 0,
    findings       TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES submissions(id),
    at            TEXT NOT NULL,
    from_status   TEXT,
    to_status     TEXT,
    note          TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sub_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_sub_unit   ON submissions(unit);
CREATE INDEX IF NOT EXISTS idx_sub_sha    ON submissions(sha256);
CREATE INDEX IF NOT EXISTS idx_checks_sub ON checks(submission_id);
CREATE INDEX IF NOT EXISTS idx_events_sub ON events(submission_id);
"""

STATUS_LABELS = {
    "new": "Новий",
    "checking": "На перевірці",
    "checked": "Перевірено",
    "accepted": "Прийнято",
    "rework": "На доопрацювання",
    "rejected": "Відхилено",
}

STATUS_ORDER = ["new", "checking", "checked", "accepted", "rework", "rejected"]


def now():
    return dt.datetime.now().replace(microsecond=0).isoformat(sep=" ")


def connect():
    os.makedirs(FILES, exist_ok=True)
    os.makedirs(BACKUPS, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_name(text):
    keep = [c for c in text if c.isalnum() or c in "._- "]
    cleaned = "".join(keep).strip().replace(" ", "_")
    return cleaned or "unit"


def next_number(conn):
    """Submission numbers are sequential per calendar year: 2026-0001."""
    year = dt.date.today().year
    row = conn.execute(
        "SELECT number FROM submissions WHERE number LIKE ? "
        "ORDER BY id DESC LIMIT 1", (f"{year}-%",)).fetchone()
    seq = int(row["number"].split("-")[1]) + 1 if row else 1
    return f"{year}-{seq:04d}"


def add_submission(conn, source_path, unit, filename=None,
                   received_at=None, user_comment=""):
    """Copy a file into storage and register it.

    Returns (submission_id, duplicate_of_id or None).
    """
    filename = filename or os.path.basename(source_path)
    received_at = received_at or now()
    digest = sha256_of(source_path)

    dup = conn.execute(
        "SELECT id, number FROM submissions WHERE sha256 = ? "
        "ORDER BY id LIMIT 1", (digest,)).fetchone()
    duplicate_of = dup["id"] if dup else None

    folder = os.path.join(FILES, _safe_name(unit))
    os.makedirs(folder, exist_ok=True)
    number = next_number(conn)
    stored_name = f"{number}_{filename}"
    stored_path = os.path.join(folder, stored_name)
    counter = 1
    while os.path.exists(stored_path):
        base, ext = os.path.splitext(stored_name)
        stored_path = os.path.join(folder, f"{base}_{counter}{ext}")
        counter += 1
    shutil.copy2(source_path, stored_path)

    cur = conn.execute(
        "INSERT INTO submissions(number, unit, filename, stored_path, "
        "size_bytes, sha256, received_at, uploaded_at, status, user_comment, "
        "duplicate_of) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (number, unit, filename,
         os.path.relpath(stored_path, BASE),
         os.path.getsize(stored_path), digest,
         received_at, now(), "new", user_comment, duplicate_of))
    sub_id = cur.lastrowid
    conn.execute(
        "INSERT INTO events(submission_id, at, from_status, to_status, note) "
        "VALUES (?,?,?,?,?)",
        (sub_id, now(), None, "new", "Подання зареєстровано"))
    conn.commit()
    return sub_id, duplicate_of


def set_status(conn, submission_id, status, note=""):
    if status not in STATUS_LABELS:
        raise ValueError(f"Невідомий статус: {status}")
    row = conn.execute("SELECT status FROM submissions WHERE id = ?",
                       (submission_id,)).fetchone()
    if row is None:
        raise ValueError("Подання не знайдено")
    if row["status"] == status:
        return
    conn.execute("UPDATE submissions SET status = ? WHERE id = ?",
                 (status, submission_id))
    conn.execute(
        "INSERT INTO events(submission_id, at, from_status, to_status, note) "
        "VALUES (?,?,?,?,?)",
        (submission_id, now(), row["status"], status, note))
    conn.commit()


def save_check(conn, submission_id, result, template_version):
    counts = result["counts"]
    conn.execute(
        "INSERT INTO checks(submission_id, run_at, template_version, verdict, "
        "critical_count, error_count, warning_count, findings) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (submission_id, now(), template_version, result["verdict"],
         counts["critical"], counts["error"], counts["warning"],
         json.dumps(result["findings"], ensure_ascii=False)))
    conn.commit()
    return conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]


def latest_check(conn, submission_id):
    row = conn.execute(
        "SELECT * FROM checks WHERE submission_id = ? "
        "ORDER BY id DESC LIMIT 1", (submission_id,)).fetchone()
    if row is None:
        return None
    data = dict(row)
    data["findings"] = json.loads(data["findings"])
    return data


def history(conn, submission_id):
    return [dict(r) for r in conn.execute(
        "SELECT * FROM events WHERE submission_id = ? ORDER BY id",
        (submission_id,)).fetchall()]


def list_submissions(conn, status=None, unit=None, query=None,
                     order="id", direction="desc"):
    allowed_order = {"id": "s.id", "number": "s.number", "unit": "s.unit",
                     "received_at": "s.received_at",
                     "uploaded_at": "s.uploaded_at", "status": "s.status",
                     "errors": "errors", "warnings": "warnings"}
    col = allowed_order.get(order, "s.id")
    way = "ASC" if str(direction).lower() == "asc" else "DESC"

    sql = """
        SELECT s.*, c.verdict, c.critical_count, c.error_count,
               c.warning_count, c.run_at AS checked_at,
               errors, warnings
        FROM submissions s
        LEFT JOIN checks c ON c.id = (
            SELECT id FROM checks WHERE submission_id = s.id
            ORDER BY id DESC LIMIT 1)
    """
    params = []
    where = []
    if status:
        where.append("s.status = ?")
        params.append(status)
    if unit:
        where.append("s.unit = ?")
        params.append(unit)
    if query:
        where.append("(s.unit LIKE ? OR s.filename LIKE ? OR s.number LIKE ?)")
        like = f"%{query}%"
        params += [like, like, like]
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += f" ORDER BY {col} {way}"

    rows = []
    for r in conn.execute(sql, params).fetchall():
        item = dict(r)
        item["status_label"] = STATUS_LABELS.get(item["status"], item["status"])
        hints = []
        if item.get("critical_count"):
            hints.append(f"критичних: {item['critical_count']}")
        if item.get("error_count"):
            hints.append(f"помилок: {item['error_count']}")
        if item.get("warning_count"):
            hints.append(f"попереджень: {item['warning_count']}")
        item["summary"] = "; ".join(hints) or (
            "без зауважень" if item.get("verdict") == "ok" else "")
        rows.append(item)
    return rows


def dashboard(conn):
    total = conn.execute("SELECT COUNT(*) AS n FROM submissions").fetchone()["n"]
    by_status = {r["status"]: r["n"] for r in conn.execute(
        "SELECT status, COUNT(*) AS n FROM submissions GROUP BY status")}
    units = conn.execute(
        "SELECT COUNT(DISTINCT unit) AS n FROM submissions").fetchone()["n"]
    recent = [dict(r) for r in conn.execute(
        "SELECT * FROM events ORDER BY id DESC LIMIT 12").fetchall()]
    for ev in recent:
        sub = conn.execute("SELECT number, unit FROM submissions WHERE id = ?",
                           (ev["submission_id"],)).fetchone()
        ev["number"] = sub["number"] if sub else "—"
        ev["unit"] = sub["unit"] if sub else "—"
        ev["status_label"] = STATUS_LABELS.get(ev["to_status"], ev["to_status"])
    return {
        "total": total,
        "units": units,
        "new": by_status.get("new", 0),
        "checking": by_status.get("checking", 0),
        "checked": by_status.get("checked", 0),
        "accepted": by_status.get("accepted", 0),
        "rework": by_status.get("rework", 0),
        "rejected": by_status.get("rejected", 0),
        "recent": recent,
    }


def backup():
    """Copy the register and stored files into a timestamped folder."""
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    target = os.path.join(BACKUPS, stamp)
    os.makedirs(target, exist_ok=True)
    if os.path.exists(DB_PATH):
        shutil.copy2(DB_PATH, os.path.join(target, "register.db"))
    archive = os.path.join(target, "units")
    shutil.copytree(FILES, archive, dirs_exist_ok=True)
    return target