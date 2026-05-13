from __future__ import annotations

import csv
import io
import json
import re
from pathlib import Path
from typing import Any


def _clean_text(text: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", text.replace("\r\n", "\n")).strip()


def _extract_sections(text: str) -> list[str]:
    sections: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#") or stripped.endswith(":") or stripped.isupper():
            sections.append(stripped[:120])
        if len(sections) >= 8:
            break
    return sections


def _summarize(text: str, name: str, warnings: list[str]) -> str:
    if not text.strip():
        if warnings:
            return f"{name} was uploaded, but structured extraction was limited. Review the warnings and use the raw file for full fidelity."
        return f"{name} was uploaded, but no readable text was extracted."
    words = text.split()
    excerpt = " ".join(words[:70])
    suffix = "..." if len(words) > 70 else ""
    return f"{name} processed successfully. Preview: {excerpt}{suffix}"


class DocumentService:
    def process(self, filename: str, content_type: str, raw: bytes) -> dict[str, Any]:
        suffix = Path(filename).suffix.lower()
        warnings: list[str] = []
        extracted = ""

        if suffix in {".txt", ".md", ".py", ".ts", ".tsx", ".js", ".json", ".html", ".csv"}:
            decoded = raw.decode("utf-8", errors="replace")
            if suffix == ".json":
                try:
                    parsed = json.loads(decoded)
                    extracted = json.dumps(parsed, indent=2)
                except json.JSONDecodeError:
                    warnings.append("JSON parsing failed. Showing raw text instead.")
                    extracted = decoded
            elif suffix == ".csv":
                reader = csv.reader(io.StringIO(decoded))
                rows = list(reader)
                extracted = "\n".join(" | ".join(cell.strip() for cell in row) for row in rows[:40])
            else:
                extracted = decoded
        else:
            warnings.append(
                "This file type is not fully parsed in the local demo yet. Text extraction currently supports TXT, MD, JSON, CSV, HTML, and code files."
            )
            if raw:
                preview = raw[:1200].decode("utf-8", errors="replace")
                extracted = preview

        extracted = _clean_text(extracted)
        return {
            "name": filename,
            "content_type": content_type or "application/octet-stream",
            "size_bytes": len(raw),
            "extracted_text": extracted,
            "summary": _summarize(extracted, filename, warnings),
            "sections": _extract_sections(extracted),
            "warnings": warnings,
        }


document_service = DocumentService()
