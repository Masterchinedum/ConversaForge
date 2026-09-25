/*!
 * ConversaForge embed SDK v1 — dependency-free.
 *
 *   <div id="cf-call"></div>
 *   <script src="https://YOUR-CONVERSAFORGE-HOST/embed.js"></script>
 *   <script>
 *     const call = ConversaForge.init({
 *       container: '#cf-call',
 *       token: 'cfe_…',              // minted by YOUR server with an API key (never ship the API key)
 *       onEvent: (e) => console.log(e.type, e),
 *     });
 *     // call.end(); call.destroy();
 *   </script>
 *
 * The token is handed to the iframe with postMessage (targeted at the ConversaForge origin), never put
 * in a URL. Messages from the iframe are only accepted from that origin and that iframe.
 */
(function (global) {
  'use strict';
  if (global.ConversaForge && global.ConversaForge.version) return;

  var VERSION = '1.0.0';
  var HOST_SOURCE = 'conversaforge-host';
  var FRAME_SOURCE = 'conversaforge-frame';
  var scriptSrc = (document.currentScript && document.currentScript.src) || '';

  function toOrigin(url) {
    try {
      var u = new URL(url, global.location.href);
      return u.protocol + '//' + u.host;
    } catch (e) {
      return null;
    }
  }

  function resolveContainer(c) {
    if (!c) return null;
    if (typeof c === 'string') return document.querySelector(c);
    if (c.nodeType === 1) return c;
    return null;
  }

  function pickParticipant(p) {
    if (!p || typeof p !== 'object') return undefined;
    var out = {};
    if (typeof p.name === 'string') out.name = p.name.slice(0, 120);
    if (typeof p.email === 'string') out.email = p.email.slice(0, 254);
    if (typeof p.externalId === 'string') out.externalId = p.externalId.slice(0, 200);
    return out;
  }

  function init(options) {
    var opts = options || {};
    var onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {};
    function emit(type, data) {
      try {
        var e = { type: type };
        if (data) for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) e[k] = data[k];
        onEvent(e);
      } catch (err) {
        if (global.console) console.error('[ConversaForge] onEvent handler threw', err);
      }
    }

    var container = resolveContainer(opts.container);
    if (!container) throw new Error('ConversaForge.init: container not found');
    if (!opts.token && !opts.linkToken) throw new Error('ConversaForge.init: pass `token` (cfe_… embed token) or `linkToken`');
    if (opts.token && !/^cfe_[A-Za-z0-9_\-.~]+$/.test(String(opts.token))) throw new Error('ConversaForge.init: `token` must be a cfe_ embed token');

    var baseUrl = opts.baseUrl || scriptSrc || '';
    var origin = toOrigin(baseUrl);
    if (!origin) throw new Error('ConversaForge.init: could not determine baseUrl');
    if (origin.indexOf('https://') !== 0 && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      throw new Error('ConversaForge.init: baseUrl must be https');
    }

    var iframe = document.createElement('iframe');
    iframe.src = origin + '/embed/frame';
    iframe.title = opts.title || 'Conversation';
    iframe.setAttribute('allow', 'microphone; camera; autoplay; clipboard-write');
    iframe.setAttribute('referrerpolicy', 'origin');
    iframe.style.width = '100%';
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.style.colorScheme = 'light';
    var height = opts.height == null ? 640 : opts.height;
    iframe.style.height = typeof height === 'number' ? height + 'px' : String(height);
    iframe.style.borderRadius = opts.borderRadius == null ? '12px' : String(opts.borderRadius);

    var initSent = false;
    var destroyed = false;
    var sessionId = null;

    function send(msg) {
      if (destroyed || !iframe.contentWindow) return;
      msg.source = HOST_SOURCE;
      iframe.contentWindow.postMessage(msg, origin);
    }

    function onMessage(ev) {
      if (destroyed) return;
      if (ev.origin !== origin || ev.source !== iframe.contentWindow) return;
      var d = ev.data;
      if (!d || typeof d !== 'object' || d.source !== FRAME_SOURCE) return;
      if (d.type === 'frame.ready') {
        if (initSent) return;
        initSent = true;
        var msg = { type: 'init', sdkVersion: VERSION };
        if (opts.token) msg.token = String(opts.token);
        else {
          msg.linkToken = String(opts.linkToken);
          // Identity hints are only honored for share-link mode (embed tokens carry identity server-side).
          msg.participant = pickParticipant(opts.participant);
          if (opts.passcode) msg.passcode = String(opts.passcode);
        }
        if (opts.variables && typeof opts.variables === 'object') msg.variables = opts.variables;
        send(msg);
      } else if (d.type === 'resize') {
        if (opts.autoHeight && typeof d.height === 'number' && d.height > 0) {
          iframe.style.height = Math.min(Math.max(320, Math.ceil(d.height)), opts.maxHeight || 2000) + 'px';
        }
      } else if (d.type === 'event' && typeof d.name === 'string') {
        var data = d.data && typeof d.data === 'object' ? d.data : {};
        if (d.name === 'session.created' && data.sessionId) sessionId = data.sessionId;
        emit(d.name, data);
      }
    }

    global.addEventListener('message', onMessage);
    container.appendChild(iframe);

    return {
      iframe: iframe,
      get sessionId() {
        return sessionId;
      },
      /** Ask the participant's call to end gracefully (no confirmation dialog). */
      end: function () {
        send({ type: 'end' });
      },
      /** Remove the iframe and listeners (the server ends an abandoned call after its timeout). */
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        global.removeEventListener('message', onMessage);
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      },
    };
  }

  global.ConversaForge = { init: init, version: VERSION };
})(window);
