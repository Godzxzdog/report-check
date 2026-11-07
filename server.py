#!/usr/bin/env python3
"""Local web app: «Робоче місце перевіряючого».

Single user, localhost only, no external requests. Static pages live in
static/, the API speaks JSON, uploaded files are parsed and checked in-process.

Run:  python3 server.py           -> http://127.0.0.1:8770/
      python3 server.py 9000      -> custom port
"""

import json
import os
import re
import shutil
import sys
import tempfile
import threading
import traceback
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import checker
import store
import xlsx_read

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
RULES = os.path.join(BASE, "rules", "template.json")
UPLOAD_TMP = os.path.join(BASE, "storage", "inbox")

HOST = "127.0.0.1"
PORT = 8770
MAX_UPLOAD = 40 * 1024 * 1024          # 40 MB per file
ALLOWED_EXT = {".xlsx"}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
}

RULES_LOCK = threading.Lock()


def load_template():
    with RULES_LOCK:
        with open(RULES, encoding="utf-8") as fh:
            return json.load(fh)


class UploadError(Exception):
    pass


def parse_multipart(handler):
    """Parse a multipart/form-data body into (fields, files).

    files: list of {"name": field, "filename": str, "data": bytes}
    """
    ctype = handler.headers.get("Content-Type", "")
    m = re.search(r'boundary="?([^";]+)"?', ctype)
    if not m:
        raise UploadError("Очікувався multipart/form-data")
    boundary = m.group(1).encode()
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0:
        raise UploadError("Порожнє тіло запиту")
    if length > MAX_UPLOAD * 30:
        raise UploadError("Занадто великий обсяг завантаження")

    body = handler.rfile.read(length)
    fields, files = {}, []
    for chunk in body.split(b"--" + boundary):
        if not chunk.strip() or chunk.strip() == b"--":
            continue
        if b"\r\n\r\n" not in chunk:
            continue
        head, payload = chunk.split(b"\r\n\r\n", 1)
        if payload.endswith(b"\r\n"):
            payload = payload[:-2]
        head_text = head.decode("utf-8", "replace")
        name_m = re.search(r'name="([^"]*)"', head_text)
        file_m = re.search(r'filename="([^"]*)"', head_text)
        field = name_m.group(1) if name_m else ""
        if file_m:
            files.append({"name": field,
                          "filename": os.path.basename(file_m.group(1)),
                          "data": payload})
        elif field:
            fields[field] = payload.decode("utf-8", "replace")
    return fields, files


def check_file(path, template):
    """Read a workbook and evaluate it. Returns (result, error_text)."""
    try:
        workbook = xlsx_read.read_workbook(path)
    except xlsx_read.XlsxError as exc:
        return {
            "verdict": "critical",
            "counts": {"critical": 1, "error": 0, "warning": 0},
            "findings": [{
                "severity": "critical", "sheet": None, "row": None,
                "column": None, "problem": str(exc),
                "recommendation": "Файл потрібно повторно сформувати у "
                                  "форматі XLSX",
                "rule": "file_unreadable"}],
        }, None
    return checker.evaluate(workbook, template), None


def run_check(conn, submission_id, template):
    row = conn.execute(
        "SELECT stored_path FROM submissions WHERE id = ?",
        (submission_id,)).fetchone()
    if row is None:
        raise ValueError("Подання не знайдено")
    path = os.path.join(BASE, row["stored_path"])
    result, _ = check_file(path, template)
    store.save_check(conn, submission_id, result, template.get("version", "—"))
    store.set_status(conn, submission_id, "checked",
                     "Автоматична перевірка завершена")
    return result


def submission_detail(conn, submission_id):
    row = conn.execute("SELECT * FROM submissions WHERE id = ?",
                       (submission_id,)).fetchone()
    if row is None:
        return None
    item = dict(row)
    item["status_label"] = store.STATUS_LABELS.get(
        item["status"], item["status"])
    item["check"] = store.latest_check(conn, submission_id)
    item["history"] = store.history(conn, submission_id)
    if item.get("duplicate_of"):
        dup = conn.execute(
            "SELECT number, filename FROM submissions WHERE id = ?",
            (item["duplicate_of"],)).fetchone()
        item["duplicate_of_number"] = dup["number"] if dup else None
        item["duplicate_of_file"] = dup["filename"] if dup else None
    return item


class Handler(BaseHTTPRequestHandler):
    server_version = "ReportCheck/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, ctype, body, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(code, "application/json; charset=utf-8", body)

    def _error(self, code, message):
        self._json(code, {"ok": False, "error": message})

    # ---------- GET ----------

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)

        try:
            if path == "/api/dashboard":
                conn = store.connect()
                try:
                    data = store.dashboard(conn)
                    tpl = load_template()
                    data["template"] = {"version": tpl.get("version"),
                                        "title": tpl.get("title")}
                    data["statuses"] = store.STATUS_LABELS
                    self._json(200, {"ok": True, "data": data})
                finally:
                    conn.close()
                return

            if path == "/api/submissions":
                conn = store.connect()
                try:
                    rows = store.list_submissions(
                        conn,
                        status=(query.get("status") or [None])[0],
                        unit=(query.get("unit") or [None])[0],
                        query=(query.get("q") or [None])[0],
                        order=(query.get("order") or ["id"])[0],
                        direction=(query.get("dir") or ["desc"])[0])
                    self._json(200, {"ok": True, "data": rows,
                                     "statuses": store.STATUS_LABELS})
                finally:
                    conn.close()
                return

            m = re.match(r"^/api/submissions/(\d+)$", path)
            if m:
                conn = store.connect()
                try:
                    item = submission_detail(conn, int(m.group(1)))
                    if item is None:
                        self._error(404, "Подання не знайдено")
                    else:
                        self._json(200, {"ok": True, "data": item})
                finally:
                    conn.close()
                return

            m = re.match(r"^/file/(\d+)$", path)
            if m:
                conn = store.connect()
                try:
                    row = conn.execute(
                        "SELECT stored_path, filename FROM submissions "
                        "WHERE id = ?", (int(m.group(1)),)).fetchone()
                finally:
                    conn.close()
                if row is None:
                    self._error(404, "Файл не знайдено")
                    return
                full = os.path.join(BASE, row["stored_path"])
                if not os.path.exists(full):
                    self._error(404, "Оригінал відсутній у сховищі")
                    return
                with open(full, "rb") as fh:
                    data = fh.read()
                name = urllib.parse.quote(row["filename"])
                self._send(
                    200,
                    "application/vnd.openxmlformats-officedocument"
                    ".spreadsheetml.sheet", data,
                    {"Content-Disposition": f"attachment; filename*=UTF-8''{name}"})
                return

            # static files
            if path in ("/", ""):
                path = "/index.html"
            name = os.path.basename(path)
            if name in ("", None):
                name = "index.html"
            full = os.path.join(STATIC, name)
            if os.path.isfile(full):
                ext = os.path.splitext(name)[1].lower()
                with open(full, "rb") as fh:
                    data = fh.read()
                self._send(200, CONTENT_TYPES.get(ext, "application/octet-stream"),
                           data)
                return

            self._error(404, "Не знайдено")
        except Exception as exc:  # noqa: BLE001 - keep the UI alive
            traceback.print_exc()
            self._error(500, f"Внутрішня помилка: {exc}")

    # ---------- POST ----------

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        try:
            if path == "/api/upload":
                self._handle_upload()
                return
            if path == "/api/recheck":
                self._handle_recheck()
                return
            if path == "/api/decision":
                self._handle_decision()
                return
            if path == "/api/backup":
                target = store.backup()
                self._json(200, {"ok": True,
                                 "data": {"path": os.path.relpath(target, BASE)}})
                return
            self._error(404, "Не знайдено")
        except UploadError as exc:
            self._error(400, str(exc))
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._error(500, f"Внутрішня помилка: {exc}")

    def _handle_upload(self):
        fields, files = parse_multipart(self)
        if not files:
            raise UploadError("Файли не отримано")
        template = load_template()
        os.makedirs(UPLOAD_TMP, exist_ok=True)
        results = []

        conn = store.connect()
        try:
            for item in files:
                filename = item["filename"] or "file.xlsx"
                ext = os.path.splitext(filename)[1].lower()
                if ext not in ALLOWED_EXT:
                    results.append({"filename": filename, "ok": False,
                                    "error": "Дозволено лише формат XLSX"})
                    continue
                if not item["data"]:
                    results.append({"filename": filename, "ok": False,
                                    "error": "Порожній файл"})
                    continue
                if len(item["data"]) > MAX_UPLOAD:
                    results.append({"filename": filename, "ok": False,
                                    "error": "Файл більший за 40 МБ"})
                    continue

                tmp = os.path.join(UPLOAD_TMP, f"{uuid.uuid4().hex}.xlsx")
                with open(tmp, "wb") as fh:
                    fh.write(item["data"])
                try:
                    unit = (fields.get("unit") or "").strip() or "Без підрозділу"
                    received = (fields.get("received_at") or "").strip()
                    sub_id, dup = store.add_submission(
                        conn, tmp, unit, filename=filename,
                        received_at=received or None)

                    store.set_status(conn, sub_id, "checking",
                                     "Розпочато автоматичну перевірку")
                    result = run_check(conn, sub_id, template)
                    results.append({
                        "filename": filename, "ok": True,
                        "submission_id": sub_id,
                        "number": conn.execute(
                            "SELECT number FROM submissions WHERE id = ?",
                            (sub_id,)).fetchone()["number"],
                        "duplicate_of": dup,
                        "verdict": result["verdict"],
                        "counts": result["counts"],
                    })
                finally:
                    if os.path.exists(tmp):
                        os.remove(tmp)
        finally:
            conn.close()

        self._json(200, {"ok": True, "data": results})

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            raise UploadError("Некоректний JSON")

    def _handle_recheck(self):
        payload = self._read_json()
        ids = payload.get("ids") or []
        if not ids:
            raise UploadError("Не вказано подання")
        template = load_template()
        conn = store.connect()
        try:
            out = []
            for sub_id in ids:
                store.set_status(conn, int(sub_id), "checking",
                                 "Повторна перевірка")
                result = run_check(conn, int(sub_id), template)
                out.append({"submission_id": int(sub_id),
                            "verdict": result["verdict"],
                            "counts": result["counts"]})
            self._json(200, {"ok": True, "data": out})
        finally:
            conn.close()

    def _handle_decision(self):
        payload = self._read_json()
        sub_id = payload.get("id")
        status = payload.get("status")
        note = (payload.get("note") or "").strip()
        if not sub_id or not status:
            raise UploadError("Потрібні поля id і status")
        if status not in store.STATUS_LABELS:
            raise UploadError("Невідомий статус")
        conn = store.connect()
        try:
            store.set_status(conn, int(sub_id), status, note or "Рішення перевіряючого")
            if note:
                conn.execute(
                    "UPDATE submissions SET user_comment = ? WHERE id = ?",
                    (note, int(sub_id)))
                conn.commit()
            self._json(200, {"ok": True,
                             "data": submission_detail(conn, int(sub_id))})
        finally:
            conn.close()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    store.connect().close()
    srv = ThreadingHTTPServer((HOST, port), Handler)
    print(f"Робоче місце перевіряючого: http://{HOST}:{port}/", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nзупинено", file=sys.stderr)


if __name__ == "__main__":
    main()