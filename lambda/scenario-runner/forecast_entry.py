"""Scenario-specific forward holiday features for the bundled forecast model."""
import os

import forecast


def main():
    original = forecast.add_features
    postal = os.environ.get('APRA_HOLIDAY_POSTAL', '').upper()
    last_actual = forecast.pd.Timestamp(os.environ['APRA_HOLIDAY_LAST_ACTUAL'])

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
