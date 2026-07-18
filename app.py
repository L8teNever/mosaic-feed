import hashlib
import io
import os
import random
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request
from PIL import Image, ImageOps

BASE_DIR = Path(__file__).resolve().parent
# DATA_DIR holds the SQLite file; overridden in Docker to point at a mounted volume.
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR))
DB_PATH = DATA_DIR / "feed.db"
UPLOAD_DIR = BASE_DIR / "static" / "uploads"
IMAGE_DIR = UPLOAD_DIR / "images"

# One converted size per upload: big enough to look sharp on a retina phone
# feed, small enough to load fast and keep storage down. The raw upload only
# ever lives in memory (see process_and_store) - it's never written to disk.
MAX_DIM = 1280
QUALITY = 82

# Weighted so posts are mostly 2-3 images, like an Instagram carousel,
# with some single-image and the occasional 4-image post.
GROUP_SIZES = [1, 2, 2, 3, 3, 3, 4]

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200 MB per request, batched uploads


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, check_same_thread=False)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hash TEXT NOT NULL UNIQUE,
            filename TEXT NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            like_count INTEGER NOT NULL DEFAULT 0,
            uploaded_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


# Runs on import, not just under `python app.py` - gunicorn (used in Docker)
# imports this module as `app:app` and never hits the __main__ block below.
init_db()


def process_and_store(data: bytes):
    """Normalize orientation, downscale once, and persist a single WEBP. Returns (name, width, height)."""
    with Image.open(io.BytesIO(data)) as img:
        img = ImageOps.exif_transpose(img)

        has_alpha = img.mode in ("RGBA", "LA", "PA") or (
            img.mode == "P" and "transparency" in img.info
        )
        img = img.convert("RGBA") if has_alpha else img.convert("RGB")
        img.thumbnail((MAX_DIM, MAX_DIM), Image.Resampling.LANCZOS)

        name = uuid.uuid4().hex
        img.save(IMAGE_DIR / f"{name}.webp", "WEBP", quality=QUALITY, method=6)

        return name, img.width, img.height


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/stats")
def stats_page():
    return render_template("stats.html")


@app.route("/api/feed")
def api_feed():
    db = get_db()
    rows = db.execute("SELECT id, filename, width, height, like_count FROM images").fetchall()
    images = [dict(r) for r in rows]
    random.shuffle(images)

    posts = []
    i = 0
    while i < len(images):
        size = random.choice(GROUP_SIZES)
        chunk = images[i : i + size]
        i += size
        posts.append(
            [
                {
                    "id": img["id"],
                    "url": f"/static/uploads/images/{img['filename']}.webp",
                    "width": img["width"],
                    "height": img["height"],
                    "like_count": img["like_count"],
                }
                for img in chunk
            ]
        )
    random.shuffle(posts)
    return jsonify({"posts": posts})


@app.route("/api/upload", methods=["POST"])
def api_upload():
    files = request.files.getlist("files")
    uploaded, duplicates, errors = 0, 0, []
    db = get_db()

    for f in files:
        if not f or not f.filename:
            continue
        data = f.read()
        if not data:
            continue
        digest = hashlib.sha256(data).hexdigest()

        existing = db.execute("SELECT id FROM images WHERE hash = ?", (digest,)).fetchone()
        if existing:
            duplicates += 1
            continue

        try:
            name, width, height = process_and_store(data)
        except Exception:
            errors.append(f.filename)
            continue

        db.execute(
            "INSERT INTO images (hash, filename, width, height, uploaded_at) VALUES (?, ?, ?, ?, ?)",
            (digest, name, width, height, datetime.now(timezone.utc).isoformat()),
        )
        db.commit()
        uploaded += 1

    return jsonify({"uploaded": uploaded, "duplicates": duplicates, "errors": errors})


@app.route("/api/like/<int:image_id>", methods=["POST"])
def api_like(image_id):
    db = get_db()
    db.execute("UPDATE images SET like_count = like_count + 1 WHERE id = ?", (image_id,))
    db.commit()
    row = db.execute("SELECT like_count FROM images WHERE id = ?", (image_id,)).fetchone()
    if row is None:
        return jsonify({"error": "not found"}), 404
    return jsonify({"id": image_id, "like_count": row["like_count"]})


@app.route("/api/unlike/<int:image_id>", methods=["POST"])
def api_unlike(image_id):
    db = get_db()
    db.execute("UPDATE images SET like_count = MAX(like_count - 1, 0) WHERE id = ?", (image_id,))
    db.commit()
    row = db.execute("SELECT like_count FROM images WHERE id = ?", (image_id,)).fetchone()
    if row is None:
        return jsonify({"error": "not found"}), 404
    return jsonify({"id": image_id, "like_count": row["like_count"]})


@app.route("/api/image/<int:image_id>", methods=["DELETE"])
def api_delete(image_id):
    db = get_db()
    row = db.execute("SELECT filename FROM images WHERE id = ?", (image_id,)).fetchone()
    if row is None:
        return jsonify({"error": "not found"}), 404

    filename = row["filename"]
    db.execute("DELETE FROM images WHERE id = ?", (image_id,))
    db.commit()

    (IMAGE_DIR / f"{filename}.webp").unlink(missing_ok=True)

    return jsonify({"ok": True})


@app.route("/api/stats")
def api_stats():
    db = get_db()
    rows = db.execute(
        "SELECT id, filename, like_count, uploaded_at FROM images "
        "ORDER BY like_count DESC, uploaded_at DESC"
    ).fetchall()
    return jsonify(
        [
            {
                "id": r["id"],
                "url": f"/static/uploads/images/{r['filename']}.webp",
                "like_count": r["like_count"],
            }
            for r in rows
        ]
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
