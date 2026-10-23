/// Opening an external URL in a new tab is a web-only capability (web-first
/// Trial, ADR 0037). On every other target this throws, and the caller falls
/// back to telling the viewer it is unavailable in this build.
void openExternalUrl(Uri url) => throw UnsupportedError(
  'Opening an external URL is only supported on the web build.',
);
