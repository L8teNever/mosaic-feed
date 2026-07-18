# Mosaic

A minimal, self-hosted, Instagram-style image feed — no stories, no accounts,
just a feed. Built with Flask + SQLite, styled after Material Design 3.

## Features

- Bulk upload (drag & drop or file picker), processed in batches with a progress bar
- Duplicate detection via SHA-256 content hash — the same file is never stored twice
- Every upload is downscaled once and saved as a single optimized WEBP (no separate
  originals kept on disk)
- Images are grouped into random-size carousels (1-4 images) and reshuffled into a
  new random order and grouping on every reload, swipe right for the next image in a post
- Permanent delete per image
- Like button: taps increment a persistent counter in the database, but the
  "liked" state itself is only kept in memory for the current page view and
  resets on reload
- `/stats` page ranking every image by total likes
- Responsive layout for mobile and desktop, light/dark theme

## Run locally

```bash
pip install -r requirements.txt
python app.py
```

Then open http://localhost:5000.

## Run with Docker

```bash
docker compose up -d
```

Pulls the prebuilt image from `ghcr.io/l8tenever/mosaic-feed:latest` (built by
the `docker-publish` GitHub Actions workflow on every push to `main`) and
persists uploads + the SQLite database in named volumes.
