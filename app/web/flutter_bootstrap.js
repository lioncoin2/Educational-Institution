{{flutter_js}}
{{flutter_build_config}}

// CanvasKit is loaded from the app's own bundle instead of Google's CDN.
//
// Two reasons this matters for this prototype:
//  1. The stage explicitly forbids calling any external service. The default
//     loader fetches CanvasKit from gstatic.com on first paint.
//  2. Arabic shaping needs CanvasKit. If that fetch fails — offline, behind a
//     proxy, on a restricted network — the app shows nothing at all.
_flutter.loader.load({
  config: {
    canvasKitBaseUrl: "canvaskit/",
  },
  serviceWorkerSettings: {
    serviceWorkerVersion: {{flutter_service_worker_version}},
  },
});
