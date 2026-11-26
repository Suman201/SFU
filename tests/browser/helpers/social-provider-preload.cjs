'use strict';
// Test process only: production URLs stay fixed in application code. Never load this fixture in production.
const origin = process.env.SFU_SOCIAL_FIXTURE_ORIGIN;
if (process.env.NODE_ENV === 'production' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin || '')) throw Error('Social fixture requires its loopback-only test provider.');
const original = global.fetch;
global.fetch = (input, init) => {
  const url = String(input);
  const routes = {
    'https://oauth2.googleapis.com/token': '/google/token',
    'https://www.googleapis.com/oauth2/v3/certs': '/google/keys',
    'https://appleid.apple.com/auth/token': '/apple/token',
    'https://appleid.apple.com/auth/keys': '/apple/keys',
  };
  return original(routes[url] ? origin + routes[url] : input, init);
};
