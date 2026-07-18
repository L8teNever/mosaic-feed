import hashlib
import io
import os
import random
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request, send_from_directory
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

# When filling out a post beyond its random seed image, pick randomly among
# the N most visually similar remaining images rather than always the single
# closest one - biases groups toward matching photos without making the
# feed feel deterministic/repetitive across reloads.
SIMILARITY_POOL = 5

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
            uploaded_at TEXT NOT NULL,
            phash TEXT
        )
        """
    )
    existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(images)")}
    if "phash" not in existing_cols:
        conn.execute("ALTER TABLE images ADD COLUMN phash TEXT")
    conn.commit()
    conn.close()


def compute_phash(img: Image.Image, hash_size: int = 8) -> str:
    """A difference-hash (dHash): shrink to a tiny grayscale grid and record
    which pixels get brighter left-to-right. Two images that look alike
    produce hashes with a small Hamming distance, so this needs no ML model
    or extra dependency beyond Pillow, which the app already requires."""
    small = img.convert("L").resize((hash_size + 1, hash_size), Image.Resampling.LANCZOS)
    pixels = list(small.getdata())
    bits = 0
    for row in range(hash_size):
        row_start = row * (hash_size + 1)
        for col in range(hash_size):
            bits = (bits << 1) | int(pixels[row_start + col] > pixels[row_start + col + 1])
    return format(bits, f"0{hash_size * hash_size // 4}x")


def hamming_distance(hash_a: str, hash_b: str) -> int:
    return bin(int(hash_a, 16) ^ int(hash_b, 16)).count("1")


def backfill_missing_phashes():
    """Images uploaded before the similarity feature existed have no phash yet."""
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT id, filename FROM images WHERE phash IS NULL"
    ).fetchall()
    for image_id, filename in rows:
        try:
            with Image.open(IMAGE_DIR / f"{filename}.webp") as img:
                phash = compute_phash(img)
        except (FileNotFoundError, OSError):
            continue
        conn.execute("UPDATE images SET phash = ? WHERE id = ?", (phash, image_id))
    conn.commit()
    conn.close()


# Runs on import, not just under `python app.py` - gunicorn (used in Docker)
# imports this module as `app:app` and never hits the __main__ block below.
init_db()
backfill_missing_phashes()


def process_and_store(data: bytes):
    """Normalize orientation, downscale once, and persist a single WEBP. Returns (name, width, height, phash)."""
    with Image.open(io.BytesIO(data)) as img:
        img = ImageOps.exif_transpose(img)

        has_alpha = img.mode in ("RGBA", "LA", "PA") or (
            img.mode == "P" and "transparency" in img.info
        )
        img = img.convert("RGBA") if has_alpha else img.convert("RGB")
        img.thumbnail((MAX_DIM, MAX_DIM), Image.Resampling.LANCZOS)
        phash = compute_phash(img)

        name = uuid.uuid4().hex
        img.save(IMAGE_DIR / f"{name}.webp", "WEBP", quality=QUALITY, method=6)

        return name, img.width, img.height, phash


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/stats")
def stats_page():
    return render_template("stats.html")


@app.route("/sw.js")
def service_worker():
    # Must be served from the root path (not /static/sw.js) so its default
    # scope covers the whole app, not just the static folder.
    return send_from_directory(app.static_folder, "sw.js")


@app.route("/api/feed")
def api_feed():
    db = get_db()
    rows = db.execute(
        "SELECT id, filename, width, height, like_count, phash FROM images"
    ).fetchall()
    images = [dict(r) for r in rows]
    random.shuffle(images)
    groups = group_by_similarity(images)
    random.shuffle(groups)

    posts = [
        [
            {
                "id": img["id"],
                "url": f"/static/uploads/images/{img['filename']}.webp",
                "width": img["width"],
                "height": img["height"],
                "like_count": img["like_count"],
            }
            for img in group
        ]
        for group in groups
    ]
    return jsonify({"posts": posts})


def group_by_similarity(images):
    """Chops a (pre-shuffled) image list into posts, filling each one out
    with visually similar images where possible instead of pure randomness -
    a random seed image starts each post, then remaining slots are filled by
    picking randomly among the SIMILARITY_POOL closest still-ungrouped
    images (by dHash Hamming distance), so alike photos end up together more
    often than photos that don't resemble each other at all."""
    pool = images[:]
    groups = []

    while pool:
        size = min(random.choice(GROUP_SIZES), len(pool))
        seed = pool.pop(random.randrange(len(pool)))
        group = [seed]

        while len(group) < size and pool:
            if seed["phash"]:
                ranked = sorted(
                    range(len(pool)),
                    key=lambda i: hamming_distance(seed["phash"], pool[i]["phash"])
                    if pool[i]["phash"]
                    else 64,
                )
                candidates = ranked[:SIMILARITY_POOL]
                pick = random.choice(candidates)
            else:
                pick = random.randrange(len(pool))
            group.append(pool.pop(pick))

        groups.append(group)

    return groups


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
            name, width, height, phash = process_and_store(data)
        except Exception:
            errors.append(f.filename)
            continue

        db.execute(
            "INSERT INTO images (hash, filename, width, height, uploaded_at, phash) VALUES (?, ?, ?, ?, ?, ?)",
            (digest, name, width, height, datetime.now(timezone.utc).isoformat(), phash),
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
