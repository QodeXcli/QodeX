"""
Reference patterns for robust, ethical data-collection bots — pure Python stdlib,
zero install, runs anywhere. The network fetch is provided for real use; the __main__
self-test exercises the OFFLINE logic (robots parsing, backoff, store, schema, dedup,
change detection) on fixtures, because a sandbox has no network. In a real project,
swap the stdlib bits for httpx + selectolax/pydantic/tenacity as needed — the *shapes*
below are what matter.
"""
from __future__ import annotations
import time, json, sqlite3, hashlib, random, urllib.request, urllib.error
from urllib import robotparser


# --- 1. robots.txt: check BEFORE fetching (here parsed from text so it's offline-testable)
def robots_allows(robots_txt: str, base_url: str, path: str, ua: str = "QodexBot") -> bool:
    rp = robotparser.RobotFileParser()
    rp.parse(robots_txt.splitlines())
    return rp.can_fetch(ua, base_url.rstrip("/") + path)

def robots_crawl_delay(robots_txt: str, ua: str = "QodexBot") -> float | None:
    rp = robotparser.RobotFileParser()
    rp.parse(robots_txt.splitlines())
    d = rp.crawl_delay(ua)
    return float(d) if d is not None else None


# --- 2. exponential backoff with jitter + Retry-After respect (pure function => testable)
def backoff_delays(retries: int, base: float = 0.5, cap: float = 30.0, retry_after=None):
    out = []
    for n in range(retries):
        if retry_after is not None and n == 0:
            out.append(float(retry_after)); continue
        expo = min(cap, base * (2 ** n))
        out.append(round(expo / 2 + random.random() * (expo / 2), 3))  # full jitter
    return out

def polite_get(url: str, ua: str = "QodexBot/1.0 (+contact)", etag: str | None = None,
               retries: int = 4, timeout: float = 20.0):
    """Real-use fetch: identify honestly, conditional GET, backoff. (network — live only)"""
    headers = {"User-Agent": ua}
    if etag:
        headers["If-None-Match"] = etag
    delays = backoff_delays(retries)
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return {"status": r.status, "etag": r.headers.get("ETag"),
                        "body": r.read().decode("utf-8", "replace")}
        except urllib.error.HTTPError as e:
            if e.code == 304:  # not modified — nothing new, that's a success for us
                return {"status": 304, "etag": etag, "body": None}
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                ra = e.headers.get("Retry-After")
                time.sleep(float(ra) if (ra and ra.isdigit()) else delays[attempt]); last = e; continue
            raise
        except urllib.error.URLError as e:
            if attempt < retries:
                time.sleep(delays[attempt]); last = e; continue
            raise
    raise last  # exhausted


# --- 3. explicit schema validation: never write a malformed record to the store
def validate_record(rec: dict, schema: dict[str, type]) -> list[str]:
    errs = []
    for field, typ in schema.items():
        if field not in rec:
            errs.append(f"missing '{field}'")
        elif not isinstance(rec[field], typ):
            errs.append(f"'{field}' is {type(rec[field]).__name__}, want {typ.__name__}")
    return errs  # empty list == valid


# --- 4. dedup / entity key
def record_key(rec: dict, fields: list[str]) -> str:
    raw = "|".join(str(rec.get(f, "")).strip().lower() for f in fields)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


# --- 5. durable incremental store (SQLite upsert; idempotent re-runs)
class Store:
    def __init__(self, path: str = ":memory:"):
        self.db = sqlite3.connect(path)
        self.db.execute("CREATE TABLE IF NOT EXISTS items "
                         "(key TEXT PRIMARY KEY, data TEXT, seen_at REAL)")
    def upsert(self, key: str, data: dict) -> bool:
        """Returns True if NEW, False if already present (so callers can count deltas)."""
        cur = self.db.execute("SELECT 1 FROM items WHERE key=?", (key,))
        is_new = cur.fetchone() is None
        self.db.execute("INSERT INTO items(key,data,seen_at) VALUES(?,?,?) "
                        "ON CONFLICT(key) DO UPDATE SET data=excluded.data, seen_at=excluded.seen_at",
                        (key, json.dumps(data, ensure_ascii=False), time.time()))
        self.db.commit()
        return is_new
    def get(self, key: str):
        row = self.db.execute("SELECT data FROM items WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None


# --- 6. change detection: emit only meaningful changes (powers monitoring/alerts)
def diff_record(old: dict | None, new: dict, watch: list[str]) -> dict:
    if old is None:
        return {"type": "new", "fields": {f: new.get(f) for f in watch}}
    changed = {f: {"from": old.get(f), "to": new.get(f)} for f in watch if old.get(f) != new.get(f)}
    return {"type": "changed", "fields": changed} if changed else {"type": "unchanged"}


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    ROBOTS = "User-agent: *\nDisallow: /private\nCrawl-delay: 2\n"
    print("robots allow /catalog:", robots_allows(ROBOTS, "https://shop.example", "/catalog"))
    print("robots allow /private:", robots_allows(ROBOTS, "https://shop.example", "/private"))
    print("crawl-delay:", robots_crawl_delay(ROBOTS))
    print("backoff (Retry-After=5):", backoff_delays(4, retry_after=5))

    schema = {"sku": str, "price": float, "title": str}
    good = {"sku": "SG-COOKIE-40", "price": 18.99, "title": "Cookie 4-pack"}
    bad  = {"sku": "X", "price": "oops"}
    print("validate good:", validate_record(good, schema))
    print("validate bad :", validate_record(bad, schema))

    store = Store()
    k = record_key(good, ["sku"])
    print("first insert new?", store.upsert(k, good))      # True
    old = store.get(k)
    updated = {**good, "price": 16.50}
    print("second insert new?", store.upsert(k, updated))  # False (idempotent)
    print("price change:", diff_record(old, updated, ["price", "title"]))
    print("\nALL PATTERNS RAN ✓")
