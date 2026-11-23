"""Holiday calendar and scenario-specific holiday features for the bundled forecast model."""
import os

import forecast


def use_calendar(days):
    """Swap forecast.py's Japanese calendar for these ISO dates, and switch
    off its two Japan-only seasons (Golden Week and Obon)."""
    ords = {forecast.pd.Timestamp(day).toordinal() for day in days}
    cache = {'ords': ords, 'sorted': forecast.np.array(sorted(ords))}
    forecast._holiday_ordinals = lambda: cache
    original = forecast._build_holiday_features

    def features(dates):
        out = original(dates)
        for column in ('is_golden_week', 'is_obon'):
            out[column] = 0
        return out

    forecast._build_holiday_features = features


def main():
    if 'APRA_HOLIDAY_CALENDAR' in os.environ:
        use_calendar([day for day in os.environ['APRA_HOLIDAY_CALENDAR'].split(',') if day])
    if 'APRA_HOLIDAY_LAST_ACTUAL' not in os.environ:  # no holiday lever in this run
        forecast.main()
        return
    last_actual = forecast.pd.Timestamp(os.environ['APRA_HOLIDAY_LAST_ACTUAL'])
    excluded = {forecast.pd.Timestamp(date).toordinal()
                for date in os.environ.get('APRA_HOLIDAY_EXCLUDED_DATES', '').split(',') if date}
    if excluded:
        original_calendar = forecast._build_holiday_features
        original_ordinals = forecast._holiday_ordinals
        cache = original_ordinals()
        remaining = cache['ords'] - {day for day in excluded if day > last_actual.toordinal()}
        revised = {'ords': remaining, 'sorted': forecast.np.array(sorted(remaining))}
        calendar_columns = ['is_holiday', 'is_holiday_eve', 'is_holiday_next',
                            'days_to_holiday', 'days_from_holiday']

        def calendar(dates):
            base = original_calendar(dates)
            forward = base[forecast.DATE] > last_actual
            if not forward.any() or remaining == cache['ords']:
                return base
            if not remaining:
                base.loc[forward, calendar_columns] = [0, 0, 0, 99, 99]
                return base
            forecast._holiday_ordinals = lambda: revised
            try:
                updated = original_calendar(dates)
            finally:
                forecast._holiday_ordinals = original_ordinals
            base.loc[forward, calendar_columns] = updated.loc[forward, calendar_columns]
            return base

        forecast._build_holiday_features = calendar

    if os.environ.get('APRA_HOLIDAY_ALL_OFF', '1') == '1':
        original = forecast.add_features
        postal = os.environ.get('APRA_HOLIDAY_POSTAL', '').upper()

        def features(*args, **kwargs):
            result = original(*args, **kwargs)
            mask = result[forecast.DATE] > last_actual
            if postal:
                mask &= result['postal_code'].astype('string').str.upper().eq(postal)
            for column in forecast.HOLIDAY_COLS:
                result.loc[mask, column] = 99 if column.startswith('days_') else 0
            if 'promo_x_holiday_eve' in result:
                result.loc[mask, 'promo_x_holiday_eve'] = 0
            return result

        forecast.add_features = features
    forecast.main()


if __name__ == '__main__':
    main()
