"""Holiday calendar for the country a run's data comes from.

forecast.py builds its holiday features from Japan's calendar. Runs on other
countries' data replace that calendar (see forecast_entry.py); Japan is left
exactly as forecast.py has it. js/scenarios.js lists the same dates.
"""
import re
from datetime import date

YEARS = range(2021, 2028)  # the years forecast.py's own calendar covers

# Fixed-date national holidays, as Getting Started pre-fills them.
_IN_FIXED = [(1, 26, 'Republic Day'), (4, 14, 'Ambedkar Jayanti'), (5, 1, 'May Day'),
             (8, 15, 'Independence Day'), (10, 2, 'Gandhi Jayanti'), (12, 25, 'Christmas')]
# The two nationwide festivals that move each year. Other lunar festivals
# vary by state or sighting and aren't guessed here.
_IN_MOVING = {
    'Holi': ['2021-03-29', '2022-03-18', '2023-03-08', '2024-03-25', '2025-03-14', '2026-03-04', '2027-03-22'],
    'Diwali': ['2021-11-04', '2022-10-24', '2023-11-12', '2024-10-31', '2025-10-20', '2026-11-08', '2027-10-29'],
}
_POSTAL = {'JP': r'\d{3}-?\d{4}', 'IN': r'[1-9]\d{5}', 'US': r'\d{5}(-\d{4})?',
           'GB': r'[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}'}


def country_of(postal_codes):
    """The country most of these postal codes belong to, or None if unclear."""
    counts = {}
    codes = {str(c).strip().upper() for c in postal_codes}
    for code in codes:
        for country, pattern in _POSTAL.items():
            if re.fullmatch(pattern, code):
                counts[country] = counts.get(country, 0) + 1
                break
    best = max(counts, key=counts.get, default=None)
    return best if best and counts[best] * 2 > len(codes) else None


def holidays(country):
    """[(ISO date, name)], or None to keep forecast.py's Japanese calendar.
    An empty list means this country has no calendar yet: no holidays at all
    rather than another country's."""
    if country in (None, 'JP'):
        return None
    if country != 'IN':
        return []
    rows = [(date(y, m, d).isoformat(), name) for y in YEARS for m, d, name in _IN_FIXED]
    rows += [(day, name) for name, days in _IN_MOVING.items() for day in days]
    return sorted(rows)
