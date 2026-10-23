// Version and build stamped by build.js. The version comes from package.json;
// the build ID is unique per build. Update emails tell users to check these, so
// they are shown on the sign-in screen and in Settings → About.

export const APP_VERSION = typeof __QSTORE_VERSION__ !== 'undefined' ? __QSTORE_VERSION__ : 'dev';
export const BUILD_ID    = typeof __QSTORE_BUILD_ID__ !== 'undefined' ? __QSTORE_BUILD_ID__ : 'dev';

export function versionLabel() {
  return `Version ${APP_VERSION} · Build ${BUILD_ID}`;
}
