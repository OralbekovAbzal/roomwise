"""
AI-powered extraction of structured booking data from free-form client messages.
No pricing or financial logic — that stays in pricing.py and /api/calc.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

from models import (
    ParsedBookingData,
    ParseResponseError,
    ParseResponseSuccess,
)


def _categories_prompt_block(categories: Optional[List[dict]]) -> Tuple[str, str, str]:
    """Build the dynamic category description and the JSON `category` hint from
    the live configuration, so the AI always picks a currently valid category id
    and knows which categories support extra beds (доп. места)."""
    if not categories:
        # Safe fallback if config is unavailable for some reason.
        listing = '- econom, standard, comfort'
        extra_ids = ["comfort"]
        id_union = '"econom" | "standard" | "comfort" | null'
    else:
        lines = []
        extra_ids = []
        for c in categories:
            cid = str(c.get("id"))
            label = str(c.get("label") or cid)
            sizes = ", ".join(str(s) for s in (c.get("room_sizes") or []))
            allow = bool(c.get("allow_extra_beds"))
            if allow:
                extra_ids.append(cid)
            extra_note = " — allows extra beds (доп. места)" if allow else ""
            lines.append(f'- id "{cid}" (label "{label}"): room sizes {sizes}{extra_note}')
        listing = "\n".join(lines)
        id_union = " | ".join(f'"{str(c.get("id"))}"' for c in categories) + " | null"

    if extra_ids:
        extra_rule = (
            "EXTRA BED (доп. место) — only for categories that allow extra beds "
            f"({', '.join(extra_ids)}):\n"
            "- A guest on an extra bed is counted ONLY in extra_bed_count (or extra_bed_meal/extra_bed_no_meal), NOT in children_meal/children_no_meal. Never count the same person twice.\n"
            '- If the client says "доп место" / "доп. кровать" / "на доп" / "extra bed", put that person ONLY in extra_bed_count.\n'
            "- For an extra-bed category, if the client does NOT say \"основное\"/\"доп\", treat a third person (e.g. a child) as an extra bed by default.\n"
            "- For categories that do NOT allow extra beds, always set extra_bed_count/extra_bed_meal/extra_bed_no_meal to 0 and count everyone as adults/children."
        )
    else:
        extra_rule = (
            "EXTRA BED (доп. место): no category currently allows extra beds — always set "
            "extra_bed_count, extra_bed_meal and extra_bed_no_meal to 0."
        )
    return listing, id_union, extra_rule


def build_parse_prompt(categories: Optional[List[dict]] = None) -> str:
    """System prompt for the extractor, with the category list, allowed room
    sizes, extra-bed rule and current year injected dynamically."""
    listing, id_union, extra_rule = _categories_prompt_block(categories)
    current_year = date.today().year
    return f"""You are a booking data extractor. Extract structured fields from the user's message and return valid JSON only.

LANGUAGE: The user message may be in Russian, English, Kazakh, or any other language. Interpret all languages correctly. Guests: взрослые/adults, дети/children/kids, с питанием/with meal, без питания/no meal. Dates may be in DD.MM.YYYY, DD/MM/YYYY, or text. Convert everything to the output format below.

CATEGORIES (use the id as the value of "category"; match the client's words to the closest label/id):
{listing}

AGE RULE (important): In our hotel, guests aged 14 years or older are charged as ADULTS; only under 14 are charged as children. If the message gives ages (e.g. "2 children 10 and 15 years", "двое детей 10 и 15 лет"), count the 15-year-old as one adult and the 10-year-old as one child. So: 2 adults + 2 children (10 and 15) → adults = 3, children = 1. Always apply this: 14+ = adult, under 14 = child.

ROOM SIZE: If the client does not specify room size/capacity, set room_size to the minimum allowed capacity of the chosen category that fits the total number of guests. Pick the smallest capacity that fits; do not use 2 when there are 4 guests.

{extra_rule}

RULES:
- Return ONLY a single JSON object. No markdown, no code fences, no explanation, no commentary.
- Do NOT calculate or estimate any prices or money.
- Extract only what is explicitly stated or clearly implied; apply the AGE RULE and ROOM SIZE rule above.
- If the room category is not clearly mentioned or does not match any category above, set "category" to null.
- Dates must be in YYYY-MM-DD format. If year is missing, use the current year {current_year}.
- Integer fields: room_size, extra_bed_count, extra_bed_meal, extra_bed_no_meal, adults_meal, children_meal, adults_no_meal, children_no_meal, disabled_adults, disabled_children must be non-negative integers.
- Percentages: prepayment_percent, discount_percent between 0 and 100.
- Extra bed: use extra_bed_meal (доп. место с питанием) and extra_bed_no_meal (доп. место без питания). If the client does not specify meal for extra bed, put all in extra_bed_meal. Defaults: extra_bed_count 0, extra_bed_meal 0, extra_bed_no_meal 0.
- Defaults when not stated: all guest counts 0, has_disabled false, disabled_adults 0, disabled_children 0, prepayment_percent 50, discount_percent 0. For room_size use the ROOM SIZE rule when guests are known.
- If required data is missing (no check-in/check-out, no category when needed, or no guests), include "missing_fields" array: e.g. ["check_in", "check_out", "category"] or ["guests"].

Output JSON shape (use exactly these keys):
{{
  "category": {id_union},
  "room_size": 2,
  "extra_bed_count": 0,
  "extra_bed_meal": 0,
  "extra_bed_no_meal": 0,
  "adults_meal": 0,
  "children_meal": 0,
  "adults_no_meal": 0,
  "children_no_meal": 0,
  "has_disabled": false,
  "disabled_adults": 0,
  "disabled_children": 0,
  "check_in": "YYYY-MM-DD" or null,
  "check_out": "YYYY-MM-DD" or null,
  "prepayment_percent": 50,
  "discount_percent": 0,
  "missing_fields": []
}}"""


def _extract_json(text: str) -> Optional[dict]:
    """Try to parse a JSON object from model output (strip markdown if present)."""
    text = text.strip()
    # Remove optional markdown code block
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if m:
        text = m.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _validate_dates(check_in: Optional[str], check_out: Optional[str]) -> bool:
    """Check ISO date format YYYY-MM-DD and that check_out > check_in."""
    if not check_in or not check_out:
        return False
    pat = re.compile(r"^\d{4}-\d{2}-\d{2}$")
    if not pat.match(check_in) or not pat.match(check_out):
        return False
    try:
        from datetime import date
        d_in = date.fromisoformat(check_in)
        d_out = date.fromisoformat(check_out)
        return d_out > d_in
    except ValueError:
        return False


def _required_missing(parsed: ParsedBookingData) -> List[str]:
    """Return list of required field names that are missing or invalid."""
    missing: List[str] = []
    if parsed.category is None:
        missing.append("category")
    if parsed.room_size is None or parsed.room_size < 1:
        missing.append("room_size")
    if not parsed.check_in or not parsed.check_out:
        if not parsed.check_in:
            missing.append("check_in")
        if not parsed.check_out:
            missing.append("check_out")
    elif not _validate_dates(parsed.check_in, parsed.check_out):
        missing.append("check_in")  # or check_out; we signal date error
    total_guests = (
        parsed.adults_meal + parsed.children_meal
        + parsed.adults_no_meal + parsed.children_no_meal
    )
    if total_guests <= 0:
        missing.append("guests")
    return missing


def _get_available_gemini_models(api_key: str) -> List[str]:
    """Return list of model IDs that support generateContent (new SDK). Prefer flash/pro for speed."""
    try:
        from google import genai
        client = genai.Client(api_key=api_key)
        candidates = []
        for m in client.models.list(page_size=100):
            name = getattr(m, "name", None) or getattr(m, "display_name", "") or ""
            if not name or "models/" not in name:
                continue
            model_id = name.replace("models/", "").strip()
            methods = getattr(m, "supported_generation_methods", None) or []
            if not methods:
                methods = getattr(m, "supported_generation_methods_list", []) or []
            if "generateContent" in str(methods):
                candidates.append(model_id)
        # Prefer flash / pro in name (faster/cheaper for parsing)
        def order_key(mid):
            if "flash" in mid:
                return (0, mid)
            if "pro" in mid:
                return (1, mid)
            return (2, mid)
        candidates.sort(key=order_key)
        return candidates[:15]
    except Exception:
        return []


def _call_gemini(message: str, api_key: str, system_prompt: str) -> str:
    """Call Gemini API; raise on network/API errors. Prefer google.genai (new SDK)."""
    prompt = system_prompt + "\n\nUser message:\n" + message
    # Fallback when ListModels is unavailable or returns nothing
    fallback_ids = (
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-2.5-flash-lite",
    )
    last_error = None

    # New SDK: google-genai (recommended, no deprecation warning)
    try:
        from google import genai
        from google.genai import types
        client = genai.Client(api_key=api_key)
        model_ids = _get_available_gemini_models(api_key) or list(fallback_ids)
        for model_id in model_ids:
            try:
                response = client.models.generate_content(
                    model=model_id,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        temperature=0.1,
                        max_output_tokens=1024,
                    ),
                )
                if response and response.text:
                    return response.text
            except Exception as e:
                last_error = e
                if "404" in str(e) or "not found" in str(e).lower():
                    continue
                if "429" in str(e) or "quota" in str(e).lower():
                    continue
                raise
        raise RuntimeError(last_error or "Empty response from Gemini")
    except ImportError:
        pass  # fall back to legacy SDK

    # Legacy SDK: google-generativeai (deprecated, still works)
    try:
        import warnings
        with warnings.catch_warnings(action="ignore", category=FutureWarning):
            import google.generativeai as genai
    except ImportError:
        raise RuntimeError(
            "Install a Gemini SDK: pip install google-genai (recommended) or pip install google-generativeai"
        ) from None

    genai.configure(api_key=api_key)
    legacy_model_ids = _get_available_gemini_models(api_key) or list(fallback_ids)
    for model_id in legacy_model_ids:
        try:
            model = genai.GenerativeModel(model_id)
            response = model.generate_content(
                prompt,
                generation_config=genai.types.GenerationConfig(
                    temperature=0.1,
                    max_output_tokens=1024,
                ),
            )
            if response and response.text:
                return response.text
        except Exception as e:
            last_error = e
            if "404" in str(e) or "not found" in str(e).lower():
                continue
            if "429" in str(e) or "quota" in str(e).lower():
                continue
            raise
    raise RuntimeError(last_error or "Empty response from Gemini")


def _parse_and_validate(raw: dict) -> Tuple[Optional[ParsedBookingData], Optional[str]]:
    """Validate raw dict into ParsedBookingData. Return (data, error_message)."""
    try:
        # Normalize: if has_disabled is false, force disabled counts to 0
        if not raw.get("has_disabled"):
            raw["disabled_adults"] = raw.get("disabled_adults") or 0
            raw["disabled_children"] = raw.get("disabled_children") or 0
        data = ParsedBookingData.model_validate(raw)
        return data, None
    except Exception as e:
        return None, str(e)


def parse_message(
    message: str,
    api_key: Optional[str] = None,
    categories: Optional[List[dict]] = None,
    cache: Optional[Dict[str, Tuple[ParseResponseSuccess | ParseResponseError, float]]] = None,
    cache_ttl_seconds: int = 600,
) -> ParseResponseSuccess | ParseResponseError:
    """
    Extract structured booking data from raw client message.
    Uses Gemini if api_key is set; otherwise returns error.
    `categories` is the live category config (id/label/room_sizes/allow_extra_beds),
    injected into the prompt and used to validate the extracted category.
    Optional in-memory cache keyed by hash(message) with TTL.
    """
    api_key = api_key or os.environ.get("GEMINI_API_KEY")
    if not api_key or not api_key.strip():
        return ParseResponseError(
            error="AI parsing unavailable",
            missing_fields=[],
        )

    system_prompt = build_parse_prompt(categories)
    known_category_ids = {str(c.get("id")) for c in (categories or [])}

    # Optional cache (keyed by message + category config so config edits invalidate)
    import time
    cache_seed = message.strip() + "|" + ",".join(sorted(known_category_ids))
    key = hashlib.sha256(cache_seed.encode()).hexdigest()
    if cache is not None:
        entry = cache.get(key)
        if entry:
            cached_response, expires = entry
            if time.time() < expires:
                return cached_response

    # Call Gemini (with one retry on invalid JSON)
    raw_json: Optional[dict] = None
    last_error: Optional[str] = None
    for attempt in range(2):
        try:
            text = _call_gemini(message, api_key, system_prompt)
            raw_json = _extract_json(text)
            if raw_json is not None:
                break
            last_error = "Invalid JSON from model"
        except Exception as e:
            last_error = str(e)
            if "AI parsing unavailable" in str(e):
                return ParseResponseError(error="AI parsing unavailable", missing_fields=[])
            # Retry on network/API errors once
            if attempt == 0:
                continue
            return ParseResponseError(
                error=last_error or "AI parsing unavailable",
                missing_fields=[],
            )

    if raw_json is None:
        return ParseResponseError(
            error=last_error or "Invalid JSON from model",
            missing_fields=[],
        )

    parsed, validation_error = _parse_and_validate(raw_json)
    if validation_error or parsed is None:
        return ParseResponseError(
            error=validation_error or "Validation failed",
            missing_fields=[],
        )

    # Reject a category the AI invented that isn't in the live config; the
    # required-fields check below will then flag it as missing.
    if known_category_ids and parsed.category not in known_category_ids:
        parsed.category = None

    # Always validate required fields server-side; never trust AI alone
    missing = _required_missing(parsed)
    if missing:
        return ParseResponseError(
            error="Missing required fields",
            missing_fields=missing,
        )

    # Build success response with normalized types
    payload = parsed.normalize_for_calc()
    if not payload:
        return ParseResponseError(error="Validation failed", missing_fields=[])

    # Normalize extra bed: if only extra_bed_count present, treat as extra_bed_meal
    extra_meal = int(payload.get("extra_bed_meal", 0))
    extra_no_meal = int(payload.get("extra_bed_no_meal", 0))
    if extra_meal == 0 and extra_no_meal == 0:
        extra_meal = int(payload.get("extra_bed_count", 0))
    payload["extra_bed_meal"] = extra_meal
    payload["extra_bed_no_meal"] = extra_no_meal

    success = ParseResponseSuccess(
        category=payload.get("category"),
        room_size=int(payload["room_size"]),
        extra_bed_count=int(payload.get("extra_bed_count", 0)),
        extra_bed_meal=extra_meal,
        extra_bed_no_meal=extra_no_meal,
        adults_meal=int(payload["adults_meal"]),
        children_meal=int(payload["children_meal"]),
        adults_no_meal=int(payload["adults_no_meal"]),
        children_no_meal=int(payload["children_no_meal"]),
        has_disabled=bool(payload["has_disabled"]),
        disabled_adults=int(payload["disabled_adults"]),
        disabled_children=int(payload["disabled_children"]),
        check_in=payload["check_in"],
        check_out=payload["check_out"],
        prepayment_percent=int(payload["prepayment_percent"]),
        discount_percent=int(payload["discount_percent"]),
        missing_fields=[],
    )

    if cache is not None:
        cache[key] = (success, time.time() + cache_ttl_seconds)

    return success
