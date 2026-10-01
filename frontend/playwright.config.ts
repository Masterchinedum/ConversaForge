import { defineConfig, devices } from '@playwright/test';

/**
 * Browser journeys. Servers are started separately (see docs/workstreams/*):
 *   E2E_WEB_URL  (default http://localhost:3000) — Next.js web app
 *   E2E_API_URL  (default http://localhost:4000) — API (used by specs to create fixtures)
 * Chromium from PLAYWRIGHT_BROWSERS_PATH (e.g. /opt/pw-browsers) with fake media devices.
 */
process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';

const fakeAudio = process.env.E2E_FAKE_AUDIO; // optional WAV for --use-file-for-fake-audio-capture

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['microphone', 'camera'],
    launchOptions: {
      // Pinned Chromium shipped in the dev image; override with E2E_CHROMIUM or unset to use Playwright's.
      executablePath: process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium',
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        ...(fakeAudio ? [`--use-file-for-fake-audio-capture=${fakeAudio}`] : []),
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
