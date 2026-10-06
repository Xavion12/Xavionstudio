"""Share links for PDFs sent on WhatsApp (receipts, member reports).

A link carries what it opens (e.g. a payment id) plus an HMAC made with a key derived from
JWT_SECRET, so it can't be guessed or edited: changing the id breaks the signature. Receipt links
don't expire; report links carry an expiry day.

    /r/<payment id>.<signature>
    /mr/<member id>.<from>.<to>.<sections>.<expires (days since 1970)>.<signature>
"""

from __future__ import annotations

import base64
import hashlib
import hmac


def _mac(kind: str, payload: str, secret: str) -> str:
    key = hashlib.sha256(f"share-link:{secret}".encode()).digest()
    digest = hmac.new(key, f"{kind}:{payload}".encode(), hashlib.sha256).digest()[:16]
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def sign(kind: str, payload: str, secret: str) -> str:
    return f"{payload}.{_mac(kind, payload, secret)}"


def verify(kind: str, token: str, secret: str) -> str | None:
    """The payload if the token is genuine, otherwise None."""
    payload, _, mac = token.rpartition(".")
    if not payload or not mac or len(token) > 200:
        return None
    return payload if hmac.compare_digest(mac, _mac(kind, payload, secret)) else None
