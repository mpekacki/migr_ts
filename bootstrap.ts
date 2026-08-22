// Tweaks that have to be in place before any dependency is loaded, so this
// module must stay the first import of main.ts. Everything here exists because
// the app ships as a single bundled file (see build.mjs).

// @salesforce/core writes its own log file through a pino transport, which pino
// loads by file path in a worker thread ('../../lib/logger/transformStream').
// That path does not exist next to the bundle, so the transport fails to start
// and every connection attempt dies with "unable to determine transport
// target". We do not use that log file - our own logs go to --output-file - so
// turn it off and let @salesforce/core log to memory instead.
process.env.SF_DISABLE_LOG_FILE = 'true';
process.env.SFDX_DISABLE_LOG_FILE = 'true';

// Node stays quiet about deprecated APIs used from inside node_modules. Bundled
// dependencies no longer live there, so Node would start printing their
// deprecation warnings (punycode via whatwg-url, url.parse via node-fetch)
// right over the UI. Nothing in this app relies on deprecated APIs, so drop
// them; other warnings are still printed.
process.noDeprecation = true;

export {};
