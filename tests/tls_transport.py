"""Read-only TLS checks. Usage: python tests/tls_transport.py https://host:port"""
import argparse
import json
import socket
import ssl
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('url')
    parser.add_argument('--connect-host')
    args = parser.parse_args()
    url = urlsplit(args.url)
    assert url.scheme == 'https'
    host, port = url.hostname, url.port or 443
    target = (args.connect_host or host, port)
    results = []

    def connect(context):
        raw = socket.create_connection(target, timeout=10)
        try:
            return context.wrap_socket(raw, server_hostname=host)
        except Exception:
            raw.close()
            raise

    # Default CA trust and hostname validation remain enabled for both versions.
    for version in (ssl.TLSVersion.TLSv1_2, ssl.TLSVersion.TLSv1_3):
        ctx = ssl.create_default_context()
        ctx.minimum_version = ctx.maximum_version = version
        with connect(ctx) as conn:
            conn.sendall(f'GET /api/health HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n'.encode())
            response = conn.recv(4096)
            assert b' 200 ' in response.split(b'\r\n', 1)[0], response[:100]
            results.append({'case': version.name, 'cipher': conn.cipher()[0], 'trusted_certificate': True, 'health': 200})

    for label, version, cipher in (
        ('TLS1.0', ssl.TLSVersion.TLSv1, 'ALL:@SECLEVEL=0'),
        ('TLS1.1', ssl.TLSVersion.TLSv1_1, 'ALL:@SECLEVEL=0'),
        ('TLS1.2 CBC', ssl.TLSVersion.TLSv1_2, 'ECDHE-RSA-AES128-SHA:@SECLEVEL=0'),
        ('TLS1.2 static RSA', ssl.TLSVersion.TLSv1_2, 'AES128-GCM-SHA256:@SECLEVEL=0'),
    ):
        ctx = ssl.create_default_context()
        ctx.minimum_version = ctx.maximum_version = version
        ctx.set_ciphers(cipher)
        try:
            conn = connect(ctx)
        except (ssl.SSLError, ConnectionResetError):
            results.append({'case': label, 'blocked': True})
        else:
            conn.close()
            raise AssertionError(label + ' unexpectedly accepted')

    for method, path in (('GET', '/'), ('POST', '/api/auth/login')):
        with socket.create_connection(target, timeout=10) as conn:
            body = b'{"login_id":"transport-probe","password":"not-a-real-credential"}' if method == 'POST' else b''
            conn.sendall(f'{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n'.encode() + body)
            try:
                response = conn.recv(4096)
            except ConnectionResetError:
                response = b''
            # A TLS-only listener closes the plaintext request before routing/login.
            assert not response or response.startswith(b'HTTP/1.1 400'), response[:100]
            results.append({'case': 'plaintext ' + method, 'blocked_before_application': True})
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
