import {
  fetchRunWeather,
  fetchRouteForecast,
  OpenMeteoRateLimitError,
} from '@/services/weather/openMeteo';

function mockFetch(
  status: number,
  body: unknown,
): jest.Mock<Promise<Response>> {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

// A day of hourly data; index == UTC hour-of-day.
function hourlyBody() {
  const time = Array.from(
    { length: 24 },
    (_, h) => `2026-03-25T${String(h).padStart(2, '0')}:00`,
  );
  return {
    hourly: {
      time,
      temperature_2m: time.map((_, h) => 20 + h * 0.1),
      relative_humidity_2m: time.map(() => 80),
      wind_speed_10m: time.map(() => 12.3),
      weather_code: time.map(() => 3),
    },
  };
}

afterEach(() => jest.restoreAllMocks());

describe('fetchRunWeather', () => {
  it('selects the hour matching the run start and maps WMO code', async () => {
    global.fetch = mockFetch(200, hourlyBody()) as unknown as typeof fetch;
    // 09:00Z → hour index 9 → temp 20 + 0.9 = 20.9
    const w = await fetchRunWeather(-23.55, -46.63, '2026-03-25T09:20:00Z');
    expect(w).toEqual({
      tempC: 20.9,
      humidityPct: 80,
      windKph: 12.3,
      conditions: 'Overcast',
    });
  });

  it('uses the archive endpoint for old runs and forecast for recent ones', async () => {
    const now = Date.parse('2026-03-25T12:00:00Z');

    const archiveMock = mockFetch(200, hourlyBody());
    global.fetch = archiveMock as unknown as typeof fetch;
    await fetchRunWeather(-23.5, -46.6, '2026-03-01T09:00:00Z', now); // 24 days old
    expect(archiveMock.mock.calls[0]![0] as string).toContain('archive-api');

    const forecastMock = mockFetch(200, hourlyBody());
    global.fetch = forecastMock as unknown as typeof fetch;
    await fetchRunWeather(-23.5, -46.6, '2026-03-24T09:00:00Z', now); // 1 day old
    expect(forecastMock.mock.calls[0]![0] as string).toContain(
      'api.open-meteo.com/v1/forecast',
    );
  });

  it('throws OpenMeteoRateLimitError on HTTP 429', async () => {
    global.fetch = mockFetch(429, {}) as unknown as typeof fetch;
    await expect(
      fetchRunWeather(-23.5, -46.6, '2026-03-01T09:00:00Z'),
    ).rejects.toBeInstanceOf(OpenMeteoRateLimitError);
  });
});

// A day of hourly data including wind direction, for the route-forecast path.
function routeHourlyBody() {
  const time = Array.from(
    { length: 24 },
    (_, h) => `2026-03-25T${String(h).padStart(2, '0')}:00`,
  );
  return {
    hourly: {
      time,
      temperature_2m: time.map((_, h) => 20 + h * 0.1),
      wind_speed_10m: time.map(() => 18.4),
      wind_direction_10m: time.map(() => 225),
      weather_code: time.map(() => 3),
    },
  };
}

describe('fetchRouteForecast', () => {
  it('selects the hour matching the instant and includes wind direction', async () => {
    global.fetch = mockFetch(200, routeHourlyBody()) as unknown as typeof fetch;
    const f = await fetchRouteForecast(52.5, 13.4, '2026-03-25T09:20:00Z');
    expect(f).toEqual({
      tempC: 20.9,
      windKph: 18.4,
      windFromDeg: 225,
      conditions: 'Overcast',
    });
  });

  it('uses the archive endpoint for old instants and forecast for recent ones', async () => {
    const now = Date.parse('2026-03-25T12:00:00Z');

    const archiveMock = mockFetch(200, routeHourlyBody());
    global.fetch = archiveMock as unknown as typeof fetch;
    await fetchRouteForecast(52.5, 13.4, '2026-03-01T09:00:00Z', now);
    expect(archiveMock.mock.calls[0]![0] as string).toContain('archive-api');

    const forecastMock = mockFetch(200, routeHourlyBody());
    global.fetch = forecastMock as unknown as typeof fetch;
    await fetchRouteForecast(52.5, 13.4, '2026-03-24T09:00:00Z', now);
    expect(forecastMock.mock.calls[0]![0] as string).toContain(
      'api.open-meteo.com/v1/forecast',
    );
  });

  it('returns null when there is no row for the requested hour', async () => {
    const body = routeHourlyBody();
    body.hourly.time = body.hourly.time.slice(0, 5); // truncate to 0–4
    global.fetch = mockFetch(200, body) as unknown as typeof fetch;
    const f = await fetchRouteForecast(52.5, 13.4, '2026-03-25T09:00:00Z');
    expect(f).toBeNull();
  });

  it('throws OpenMeteoRateLimitError on HTTP 429', async () => {
    global.fetch = mockFetch(429, {}) as unknown as typeof fetch;
    await expect(
      fetchRouteForecast(52.5, 13.4, '2026-03-01T09:00:00Z'),
    ).rejects.toBeInstanceOf(OpenMeteoRateLimitError);
  });

  it('rejects an invalid instant', async () => {
    await expect(
      fetchRouteForecast(52.5, 13.4, 'not-a-date'),
    ).rejects.toThrow();
  });
});
