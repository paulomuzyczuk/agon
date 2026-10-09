// Deterministic env for the unit lane. No real network or DB is touched here —
// the Strava client's fetch is mocked and DB-touching code lives in the
// integration lane. These placeholders just satisfy env reads in module init.
process.env.DATABASE_URL = 'postgresql://agon:agon@127.0.0.1:5432/agon_test';
process.env.STRAVA_CLIENT_ID = '000000';
process.env.STRAVA_CLIENT_SECRET = 'mock-strava-client-secret';
process.env.STRAVA_REDIRECT_URI = 'http://localhost:3000/strava/callback';
process.env.FITBIT_CLIENT_ID = 'MOCKID';
process.env.FITBIT_CLIENT_SECRET = 'mock-fitbit-client-secret';
process.env.FITBIT_REDIRECT_URI = 'http://localhost:3000/fitbit/callback';
process.env.TZ = 'UTC';
// Unit tests read a committed fixture profile, never the developer's own
// config/athlete-profile.local.json (gitignored, absent in CI). The example
// profile's values, plus the program start date and time zone the training-block
// tests assert; both are stated in CLAUDE.md, so no personal data is added.
process.env.AGON_ATHLETE_PROFILE_PATH = `${__dirname}/__tests__/fixtures/athlete-profile.unit.json`;
