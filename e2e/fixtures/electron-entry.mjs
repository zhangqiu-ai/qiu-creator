import { app } from 'electron';

// Keep Chromium's persistent state in the test profile before loading the app.
const profile = process.env.CREATORHUB_E2E_PROFILE;
if (!profile) throw new Error('CREATORHUB_E2E_PROFILE is required');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
await import('../../apps/mac/dist-electron/main.cjs');
