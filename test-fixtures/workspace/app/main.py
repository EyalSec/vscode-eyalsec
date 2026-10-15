"""Starts the demo app. The extension's tests point events at it."""
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from handler import ping_host


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        ping_host(type("Request", (), {"args": dict(parse_qs(urlparse(self.path).query))}))
        self.send_response(204)
        self.end_headers()


def serve():
    HTTPServer(("127.0.0.1", 8080), Handler).serve_forever()

serve()
