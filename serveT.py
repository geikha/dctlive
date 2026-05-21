from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import sys

class CORSRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        SimpleHTTPRequestHandler.end_headers(self)

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 2357
    server_address = ('', port)

    httpd = ThreadingHTTPServer(server_address, CORSRequestHandler)
    print(f"Serving on port {port}")
    httpd.serve_forever()
