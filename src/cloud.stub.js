// Cloud provider stub — substituted for src/cloud.js in the Defence/cadet build.
//
// See sync.stub.js for the rationale. This module exists so that nothing in the
// dependency graph pulls in @azure/msal-browser or the Microsoft Graph client:
// build.js --defence resolves './cloud.js' here instead, and the real provider
// never enters the bundle.
//
// The returned provider reports 'disabled' and is never signed in, so any code
// path that survived the settings gating still fails closed rather than
// attempting a network call.

const DISABLED_INFO = Object.freeze({
  state:     'disabled',
  lastSync:  null,
  lastError: null,
  disabled:  true,
});

const _stubProvider = Object.freeze({
  async init() {},
  isSignedIn() { return false; },
  getAccount() { return null; },
  getStatusInfo() { return { ...DISABLED_INFO }; },
  async signIn()  { throw new Error('Cloud sync is not available in this build.'); },
  async signOut() {},
  async read()    { throw new Error('Cloud sync is not available in this build.'); },
  async write()   { throw new Error('Cloud sync is not available in this build.'); },
  async resetAuthState() {},
});

export function getProvider() {
  return _stubProvider;
}

export function _setProvider() {
  throw new Error('Cloud sync is not available in this build.');
}

export async function handlePopupAuth() {}
