"""GST included in a price (all amounts in paise).

The price already contains the tax, so it is split back out:

    taxable = price × 100 / (100 + rate)        ₹21,999 at 5% → ₹20,951.43
    GST     = price − taxable                                   →  ₹1,047.57
    CGST    = half of the GST (the odd paisa), SGST = the rest  →    ₹523.79 + ₹523.78

taxable + CGST + SGST is always exactly the price.
"""

from __future__ import annotations

from typing import Any


def gst_split(amount: int, rate: int) -> dict[str, Any] | None:
    if not rate or amount <= 0:
        return None
    taxable = round(amount * 100 / (100 + rate))
    tax = amount - taxable
    sgst = tax // 2
    return {"rate": rate, "taxable": taxable, "amount": tax, "cgst": tax - sgst, "sgst": sgst}
