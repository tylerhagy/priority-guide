#!/usr/bin/env python3
"""
serve.py — static server for priority-guide.

WHY NOT `python3 -m http.server`
That module sends only Last-Modified, so a soft refresh can pair a fresh
index.html with a stale parser.js. The ES module import then fails silently and
the app renders as a header over a blank page with no error anywhere. Sending
Cache-Control: no-store makes that impossible.

WHY NOT a document-serving CLI
Those rewrite HTML — inject a favicon, add source-line attributes, bolt on a
comment layer that hooks text selection. Right for reading documents, wrong for
an app with inline editing.
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoStoreHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        SimpleHTTPRequestHandler.end_headers(self)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8044
    root = Path(__file__).resolve().parent
    handler = partial(NoStoreHandler, directory=str(root))
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        sys.stderr.write("priority-guide serving %s at http://localhost:%d\n" % (root, port))
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
