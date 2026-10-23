import 'package:web/web.dart' as web;

/// Opens [url] in a new browser tab with no handle back to this app
/// (`noopener,noreferrer`) — the browser's own safe navigation. Used to view or
/// download a signed attachment link and to follow a link in a message. The
/// caller validates the scheme (http/https only) before calling.
void openExternalUrl(Uri url) =>
    web.window.open(url.toString(), '_blank', 'noopener,noreferrer');
