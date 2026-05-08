// PDFRealm lightweight analytics
// Connects to GA4 if available, otherwise logs to console in dev
(function() {
  'use strict';

  function track(event, props) {
    props = props || {};
    props.timestamp = Date.now();
    props.page = window.location.pathname;

    // GA4
    if (window.gtag) {
      window.gtag('event', event, props);
    }

    // PostHog
    if (window.posthog) {
      window.posthog.capture(event, props);
    }

    // Server-side event log (fire and forget)
    try {
      fetch('/api/analytics/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: event, props: props }),
        keepalive: true
      }).catch(function() {});
    } catch(e) {}
  }

  // Expose globally
  window.pdfTrack = track;

  // Auto-track page view
  track('page_view', {
    url: window.location.href,
    referrer: document.referrer
  });

  // Universal file upload tracking via event delegation
  document.addEventListener('change', function(e) {
    var el = e.target;
    if (el && el.type === 'file' && el.files && el.files.length > 0) {
      var toolName = el.closest('[data-tool-view]') && el.closest('[data-tool-view]').getAttribute('data-tool-view');
      var fileType = el.files[0] && el.files[0].name ? el.files[0].name.split('.').pop().toLowerCase() : '';
      track('upload_started', {
        toolName: toolName || el.id || 'unknown',
        fileType: fileType
      });
    }
  }, true);

})();
