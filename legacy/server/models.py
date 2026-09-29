from datetime import date
from typing import List, Optional

from pydantic import BaseModel, Field, model_validator


# --- Parse API (AI extraction only; no pricing) ---

class ParseRequest(BaseModel):
    message: str


class ParsedBookingData(BaseModel):
    """Validated output from AI. All pricing stays in /api/calc."""
    category: Optional[str] = None
    room_size: int = Field(ge=0, default=2)
    extra_bed_count: int = Field(ge=0, default=0)  # legacy: summed into extra_bed_meal if no meal fields
    extra_bed_meal: int = Field(ge=0, default=0)
    extra_bed_no_meal: int = Field(ge=0, default=0)
    adults_meal: int = Field(ge=0, default=0)
    children_meal: int = Field(ge=0, default=0)
    adults_no_meal: int = Field(ge=0, default=0)
    children_no_meal: int = Field(ge=0, default=0)
    has_disabled: bool = False
    disabled_adults: int = Field(ge=0, default=0)
    disabled_children: int = Field(ge=0, default=0)
    check_in: Optional[str] = None  # YYYY-MM-DD
    check_out: Optional[str] = None
    prepayment_percent: int = Field(ge=0, le=100, default=50)
    discount_percent: int = Field(ge=0, le=100, default=0)
    missing_fields: List[str] = Field(default_factory=list)

    def normalize_for_calc(self) -> Optional[dict]:
        """If has_disabled is False, force disabled counts to 0. Used after validation."""
        d = self.model_dump()
        if not d.get("has_disabled"):
            d["disabled_adults"] = 0
            d["disabled_children"] = 0
        return d


class ParseResponseSuccess(BaseModel):
    """Successful parse: structured data only. No money, no calculations."""
    category: Optional[str] = None
    room_size: int = Field(ge=0)
    extra_bed_count: int = Field(ge=0)
    extra_bed_meal: int = Field(ge=0)
    extra_bed_no_meal: int = Field(ge=0)
    adults_meal: int = Field(ge=0)
    children_meal: int = Field(ge=0)
    adults_no_meal: int = Field(ge=0)
    children_no_meal: int = Field(ge=0)
    has_disabled: bool = False
    disabled_adults: int = Field(ge=0)
    disabled_children: int = Field(ge=0)
    check_in: str  # YYYY-MM-DD
    check_out: str
    prepayment_percent: int = Field(ge=0, le=100)
    discount_percent: int = Field(ge=0, le=100)
    missing_fields: List[str] = Field(default_factory=list)


class ParseResponseError(BaseModel):
    error: str
    missing_fields: List[str]


# --- Calculator API ---

class CalcRequest(BaseModel):
    category: str
    room_size: int = Field(ge=1)
    extra_bed_count: int = Field(ge=0, default=0)  # deprecated: use extra_bed_meal + extra_bed_no_meal
    extra_bed_meal: int = Field(ge=0, default=0)
    extra_bed_no_meal: int = Field(ge=0, default=0)

    adults_meal: int = Field(ge=0, default=0)
    children_meal: int = Field(ge=0, default=0)

    adults_no_meal: int = Field(ge=0, default=0)
    children_no_meal: int = Field(ge=0, default=0)

    has_disabled: bool = False
    disabled_adults: int = Field(ge=0, default=0)
    disabled_children: int = Field(ge=0, default=0)

    check_in: date
    check_out: date

    prepayment_percent: int = Field(ge=0, le=100, default=50)
    discount_percent: int = Field(ge=0, le=100, default=0)

    @model_validator(mode="after")
    def normalize_extra_bed(self):
        if self.extra_bed_meal == 0 and self.extra_bed_no_meal == 0 and self.extra_bed_count > 0:
            return self.model_copy(update={"extra_bed_meal": self.extra_bed_count})
        return self


class CalcResponse(BaseModel):
    result_text: str
    total: int
    total_after_discount: int
    prepayment_amount: int
    breakdown: List[dict] = Field(default_factory=list)

