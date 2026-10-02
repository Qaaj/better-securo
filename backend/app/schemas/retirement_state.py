from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator

KEY_PREFIX = "retirement:"
MAX_KEYS = 50
MAX_BYTES = 1_000_000


class RetirementStateWrite(BaseModel):
    data: dict[str, Any] = Field(default_factory=dict)

    @field_validator("data")
    @classmethod
    def _check(cls, value: dict[str, Any]) -> dict[str, Any]:
        import json

        if len(value) > MAX_KEYS:
            raise ValueError("Too many entries")
        if any(not key.startswith(KEY_PREFIX) for key in value):
            raise ValueError(f"Every key must start with '{KEY_PREFIX}'")
        if len(json.dumps(value)) > MAX_BYTES:
            raise ValueError("Too large")
        return value


class RetirementStateRead(BaseModel):
    data: dict[str, Any]
    updated_at: datetime | None = None
