-- Signed-in devices and the activity log (Security page, admin only).
--
-- sessions: one row per sign-in (browser / phone). The sign-in token carries the row id, so a
-- device can be signed out on its own. A session is active while it hasn't ended, hasn't expired,
-- and its token_version still matches the user's (a password change or disabled account ends it).
CREATE TABLE sessions (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL,
    token_version INTEGER NOT NULL,
    created_at    TEXT    NOT NULL,
    last_seen_at  TEXT    NOT NULL,
    expires_at    TEXT    NOT NULL,
    ip            TEXT    CHECK (ip IS NULL OR length(ip) <= 64),
    user_agent    TEXT    CHECK (user_agent IS NULL OR length(user_agent) <= 300),
    ended_at      TEXT,
    end_reason    TEXT    CHECK (end_reason IS NULL OR end_reason IN ('LOGOUT', 'SIGNED_OUT_BY_ADMIN', 'PASSWORD_CHANGED', 'LOGOUT_ALL'))
);
CREATE INDEX idx_sessions_user ON sessions (user_id, ended_at);
CREATE INDEX idx_sessions_active ON sessions (expires_at) WHERE ended_at IS NULL;

-- Who did what, when, from which device. Kept 365 days (daily cleanup).
CREATE TABLE activity_log (
    id         INTEGER PRIMARY KEY,
    at         TEXT    NOT NULL,
    user_id    INTEGER,
    action     TEXT    NOT NULL CHECK (length(action) <= 40),
    category   TEXT    NOT NULL CHECK (length(category) <= 20),
    summary    TEXT    NOT NULL CHECK (length(summary) <= 200),
    target     TEXT    CHECK (target IS NULL OR length(target) <= 200),
    ip         TEXT    CHECK (ip IS NULL OR length(ip) <= 64),
    device     TEXT    CHECK (device IS NULL OR length(device) <= 80),
    session_id INTEGER
);
CREATE INDEX idx_activity_at ON activity_log (at);
CREATE INDEX idx_activity_user ON activity_log (user_id, at);
CREATE INDEX idx_activity_category ON activity_log (category, at);
