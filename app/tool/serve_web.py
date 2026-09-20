#!/usr/bin/env python3
"""Static server for the built web app, with SPA fallback.

`flutter build web` produces a single-page app: every route is served by
index.html and go_router picks it up from the URL. A plain static server
returns 404 for /home or /programs/..., so deep links look broken.

Usage:
    python3 tool/serve_web.py [port]      # default 8080
"""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build", "web")


class SpaHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        full = super().translate_path(path)
        if os.path.isdir(full) or os.path.exists(full):
            return full
        # Unknown path with no file extension -> let the SPA route it.
        if not os.path.splitext(path.split("?", 1)[0])[1]:
            return os.path.join(ROOT, "index.html")
        return full

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def main():
    if not os.path.isdir(ROOT):
        sys.exit("build/web not found — run: flutter build web --release")
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = partial(SpaHandler, directory=ROOT)
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"http://127.0.0.1:{port}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
