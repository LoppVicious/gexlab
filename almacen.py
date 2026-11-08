"""GEX Lab - almacen de objetos del motor en la nube.

Dos backends con la misma interfaz:
  local:<carpeta>   archivos en disco (pruebas y desarrollo)
  r2                Cloudflare R2 (API compatible con S3). Variables: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
                    R2_SECRET_ACCESS_KEY y R2_BUCKET (por defecto "gexlab").

Se elige con la variable GEX_ALMACEN (por defecto local:./almacen).
Los JSON se guardan comprimidos con gzip y marcados con Content-Encoding: gzip, de modo que la API los puede
servir tal cual y el navegador los descomprime solo.
"""
from __future__ import annotations

import gzip
import json
import os


class Local:
    def __init__(self, root: str):
        self.root = os.path.abspath(root)

    def _p(self, key: str) -> str:
        key = key.lstrip("/")
        if ".." in key.split("/"):
            raise ValueError("clave no valida")
        return os.path.join(self.root, *key.split("/"))

    def get(self, key: str) -> bytes | None:
        try:
            with open(self._p(key), "rb") as f:
                return f.read()
        except FileNotFoundError:
            return None

    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream", gz: bool = False) -> None:
        p = self._p(key)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, p)

    def delete(self, key: str) -> None:
        try:
            os.remove(self._p(key))
        except FileNotFoundError:
            pass

    def list(self, prefix: str) -> list[str]:
        base = self._p(prefix) if prefix else self.root
        out = []
        d = base if os.path.isdir(base) else os.path.dirname(base)
        for dirpath, _, files in os.walk(d):
            for fn in files:
                if fn.endswith(".tmp"):
                    continue
                k = os.path.relpath(os.path.join(dirpath, fn), self.root).replace(os.sep, "/")
                if k.startswith(prefix):
                    out.append(k)
        return sorted(out)

    def sizes(self, prefix: str = "") -> list[tuple[str, int]]:
        return [(k, os.path.getsize(self._p(k))) for k in self.list(prefix)]


class R2:
    def __init__(self):
        import boto3  # solo hace falta en la nube
        from botocore.config import Config
        acc = os.environ["R2_ACCOUNT_ID"]
        self.bucket = os.environ.get("R2_BUCKET", "gexlab")
        self.s3 = boto3.client(
            "s3", endpoint_url=f"https://{acc}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto", config=Config(retries={"max_attempts": 5, "mode": "standard"}))

    def get(self, key: str) -> bytes | None:
        try:
            return self.s3.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except self.s3.exceptions.NoSuchKey:
            return None

    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream", gz: bool = False) -> None:
        extra = {"ContentEncoding": "gzip"} if gz else {}
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type,
                           CacheControl="no-cache", **extra)

    def delete(self, key: str) -> None:
        self.s3.delete_object(Bucket=self.bucket, Key=key)

    def list(self, prefix: str) -> list[str]:
        out, token = [], None
        while True:
            kw = {"Bucket": self.bucket, "Prefix": prefix}
            if token:
                kw["ContinuationToken"] = token
            r = self.s3.list_objects_v2(**kw)
            out += [o["Key"] for o in r.get("Contents", [])]
            if not r.get("IsTruncated"):
                return sorted(out)
            token = r["NextContinuationToken"]

    def sizes(self, prefix: str = "") -> list[tuple[str, int]]:
        out, token = [], None
        while True:
            kw = {"Bucket": self.bucket, "Prefix": prefix}
            if token:
                kw["ContinuationToken"] = token
            r = self.s3.list_objects_v2(**kw)
            out += [(o["Key"], int(o["Size"])) for o in r.get("Contents", [])]
            if not r.get("IsTruncated"):
                return out
            token = r["NextContinuationToken"]


def uso(st) -> dict:
    """Espacio ocupado por carpeta de primer nivel (y por subcarpeta en hist500/): lo muestra el panel de administracion."""
    por: dict[str, dict] = {}
    total = n = 0
    for k, b in st.sizes(""):
        parts = k.split("/")
        grupo = "/".join(parts[:2]) if parts[0] == "hist500" and len(parts) > 2 else parts[0]
        g = por.setdefault(grupo, {"n": 0, "bytes": 0})
        g["n"] += 1
        g["bytes"] += b
        total += b
        n += 1
    return {"total": total, "n": n, "por": dict(sorted(por.items(), key=lambda x: -x[1]["bytes"]))}


def abrir():
    spec = os.environ.get("GEX_ALMACEN", "local:./almacen")
    if spec == "r2":
        return R2()
    if spec.startswith("local:"):
        return Local(spec[6:])
    raise ValueError(f"GEX_ALMACEN no valido: {spec}")


# ---------------------------------------------------------------- JSON comprimido
def _clean(o):
    if isinstance(o, float):
        return o if o == o and o not in (float("inf"), float("-inf")) else None
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    return o


def dumps(obj) -> bytes:
    try:
        s = json.dumps(obj, separators=(",", ":"), allow_nan=False)
    except ValueError:  # NaN o infinito: JSON.parse del navegador no los acepta
        s = json.dumps(_clean(obj), separators=(",", ":"), allow_nan=False)
    return s.encode("utf-8")


def put_json(st, key: str, obj) -> int:
    data = gzip.compress(dumps(obj), compresslevel=6)
    st.put(key, data, "application/json; charset=utf-8", gz=True)
    return len(data)


def get_json(st, key: str, default=None):
    b = st.get(key)
    if b is None:
        return default
    if b[:2] == b"\x1f\x8b":
        b = gzip.decompress(b)
    return json.loads(b.decode("utf-8"))
