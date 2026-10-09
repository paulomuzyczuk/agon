import { wmoWeatherDescription } from '@/lib/weatherCodes';

describe('wmoWeatherDescription', () => {
  it('maps known WMO codes', () => {
    expect(wmoWeatherDescription(0)).toBe('Clear');
    expect(wmoWeatherDescription(3)).toBe('Overcast');
    expect(wmoWeatherDescription(63)).toBe('Rain');
    expect(wmoWeatherDescription(95)).toBe('Thunderstorm');
  });

  it('falls back for an unknown code and nulls a missing one', () => {
    expect(wmoWeatherDescription(123)).toBe('Code 123');
    expect(wmoWeatherDescription(null)).toBeNull();
    expect(wmoWeatherDescription(undefined)).toBeNull();
  });
});
