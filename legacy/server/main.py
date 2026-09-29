from __future__ import annotations

import json
import socket
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

from models import CalcRequest, CalcResponse, ParseRequest
from parse import parse_message
from pricing import PricingEngine, PricingError


BASE_DIR = Path(__file__).resolve().parent


def _get_prices_path() -> Path:
    """
    Determine where to load prices.json from.

    - When running from source (py -m project.main), load from the
      project folder alongside main.py.
    - When frozen into an .exe with PyInstaller, load from the current
      working directory, so admins can put prices.json next to the exe.
    """
    if getattr(sys, "frozen", False):
        # PyInstaller frozen executable: use current directory
        return Path.cwd() / "prices.json"
    # Source run: use the package directory
    return BASE_DIR / "prices.json"


PRICES_PATH = _get_prices_path()


def _get_gemini_key_path() -> Path:
    """Path to the file where the Gemini API key is stored (same dir as prices.json)."""
    return PRICES_PATH.parent / "gemini_api_key.txt"


GEMINI_KEY_FILE = _get_gemini_key_path()


def _read_gemini_api_key() -> Optional[str]:
    """Read API key from file first (two possible locations), then from env. Returns None if not set."""
    import os
    candidates = [
        GEMINI_KEY_FILE,
        Path.cwd() / "gemini_api_key.txt",
    ]
    for path in candidates:
        if path.exists():
            try:
                key = path.read_text(encoding="utf-8").strip()
                if key:
                    return key
            except OSError:
                pass
    return os.environ.get("GEMINI_API_KEY") or None


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        engine = PricingEngine.from_file(PRICES_PATH)
    except FileNotFoundError:
        msg = f"prices.json not found in current directory: {PRICES_PATH}"
        print(f"ERROR: {msg}")
        sys.exit(1)
    except Exception as exc:  # pragma: no cover - defensive
        print(f"ERROR loading prices.json: {exc}")
        sys.exit(1)
    app.state.pricing_engine = engine
    yield


app = FastAPI(title="Turan Resort Admin Price Calculator", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


static_dir = BASE_DIR / "static"


@app.get("/", response_class=HTMLResponse)
async def index():
    index_path = static_dir / "index.html"
    if not index_path.exists():
        return HTMLResponse(
            content="<h1>Turan Resort Admin Calculator</h1><p>Frontend not found.</p>",
            status_code=200,
        )
    return FileResponse(index_path)


@app.get("/admin/pricing", response_class=HTMLResponse)
async def pricing_page():
    settings_path = static_dir / "settings.html"
    if not settings_path.exists():
        return await index()
    return FileResponse(settings_path)


@app.get("/admin/parse", response_class=HTMLResponse)
async def parse_page():
    parse_path = BASE_DIR / "static" / "parse.html"
    if not parse_path.exists():
        return await index()
    return FileResponse(parse_path)


@app.get("/admin/api-key", response_class=HTMLResponse)
async def api_key_page():
    path = static_dir / "api-key.html"
    if not path.exists():
        return await index()
    return FileResponse(path)


@app.get("/history", response_class=HTMLResponse)
async def history_page():
    path = static_dir / "history.html"
    if not path.exists():
        return await index()
    return FileResponse(path)


if static_dir.exists():
    app.mount("/static", StaticFiles(directory=static_dir), name="static")


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    icon = static_dir / "favicon.ico"
    if icon.exists():
        return FileResponse(icon)
    from fastapi.responses import Response
    return Response(status_code=204)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


# Optional in-memory cache for parse results: key = hash(message), value = (response, expiry_time)
_parse_cache: Dict[str, tuple] = {}


@app.post("/api/parse")
async def parse_client_message(payload: ParseRequest):
    """
    Extract structured booking data from raw client message using Gemini.
    No pricing or calculations — only structuring and missing-field detection.
    """
    api_key = _read_gemini_api_key()
    engine: PricingEngine = app.state.pricing_engine
    try:
        result = parse_message(
            message=payload.message,
            api_key=api_key,
            categories=engine.categories_raw,
            cache=_parse_cache,
            cache_ttl_seconds=600,
        )
    except Exception as exc:
        msg = (str(exc) or "AI parsing unavailable").strip()
        if len(msg) > 300 or "AIza" in msg:
            msg = "AI parsing unavailable"
        else:
            msg = "AI parsing unavailable: " + msg if msg != "AI parsing unavailable" else msg
        return {
            "error": msg,
            "missing_fields": [],
        }
    if hasattr(result, "error"):
        return {"error": result.error, "missing_fields": result.missing_fields}
    return result.model_dump()


@app.post("/api/calc", response_model=CalcResponse)
async def calculate(payload: CalcRequest):
    engine: PricingEngine = app.state.pricing_engine
    try:
        result_text, total, total_after_discount, prepayment_amount, breakdown = (
            engine.calculate(payload)
        )
    except PricingError as exc:
        raise HTTPException(
            status_code=400,
            detail={"message": str(exc)},
        ) from exc
    except Exception as exc:  # pragma: no cover - generic guard
        raise HTTPException(
            status_code=500,
            detail={"message": "Internal error during calculation."},
        ) from exc

    return CalcResponse(
        result_text=result_text,
        total=total,
        total_after_discount=total_after_discount,
        prepayment_amount=prepayment_amount,
        breakdown=breakdown,
    )


@app.get("/api/admin/prices")
async def get_prices() -> Dict[str, Any]:
    """
    Return the current pricing configuration (what's in prices.json / engine).
    """
    engine: PricingEngine = app.state.pricing_engine
    return {
        "constants": engine.constants,
        "periods": engine.periods_raw,
        "categories": engine.categories_raw,
        "prices": engine.prices,
    }


@app.get("/api/categories")
async def get_categories() -> Dict[str, Any]:
    """Lightweight category metadata (no prices) for the calculator and AI page:
    dropdown options, allowed room sizes, and the extra-bed toggle."""
    engine: PricingEngine = app.state.pricing_engine
    cats = []
    for c in engine.categories.values():
        cats.append(
            {
                "id": c.id,
                "label": c.label,
                "room_sizes": sorted(c.room_sizes),
                "allow_extra_beds": c.allow_extra_beds,
            }
        )
    return {"categories": cats}


@app.get("/api/admin/gemini-key")
async def get_gemini_key_status() -> Dict[str, Any]:
    """Return whether a Gemini API key is configured (from file or env). Never returns the key."""
    key = _read_gemini_api_key()
    return {
        "configured": bool(key and key.strip()),
        "key_file": str(GEMINI_KEY_FILE.resolve()),
    }


@app.post("/api/admin/gemini-key")
async def save_gemini_key(payload: Dict[str, Any]) -> Dict[str, str]:
    """Save or clear the Gemini API key in the local file. Body: { \"api_key\": \"...\" }."""
    raw = payload.get("api_key")
    value = (raw if isinstance(raw, str) else "").strip()
    try:
        GEMINI_KEY_FILE.write_text(value, encoding="utf-8")
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail={"message": f"Failed to save API key file: {exc}"},
        ) from exc
    return {"status": "ok"}


@app.post("/api/admin/prices")
async def update_prices(payload: Dict[str, Any]) -> Dict[str, str]:
    """
    Replace pricing configuration and persist to prices.json.
    """
    try:
        new_engine = PricingEngine(payload)
    except PricingError as exc:
        raise HTTPException(
            status_code=400,
            detail={"message": str(exc)},
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail={"message": "Invalid pricing structure."},
        ) from exc

    try:
        with PRICES_PATH.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail={"message": f"Failed to write prices.json: {exc}"},
        ) from exc

    app.state.pricing_engine = new_engine
    return {"status": "ok"}


def _detect_local_ip() -> str:
    """Best-effort detection of LAN IP."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main():
    if not PRICES_PATH.exists():
        print(f"ERROR: prices.json not found in current directory: {PRICES_PATH}")
        sys.exit(1)

    local_ip = _detect_local_ip()
    print("Server running at:")
    print(f"http://{local_ip}:8080")

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8080,
        reload=False,
    )


if __name__ == "__main__":
    main()

