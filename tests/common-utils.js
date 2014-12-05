'use strict';

var commonUtils = {};

commonUtils.couchHost = function () {
  if (typeof module !== 'undefined' && module.exports) {
    return process.env.COUCH_HOST || 'http://localhost:5984';
  } else if (window && window.COUCH_HOST) {
    return window.COUCH_HOST;
  } else if (window && window.cordova) {
      // magic route to localhost on android emulator
    return 'http://10.0.2.2:2020';
  }
  // In the browser we default to the CORS server, in future will change
  return 'http://localhost:2020';
};

commonUtils.safeRandomDBName = function () {
  return "test" + Math.random().toString().replace('.', '_');
};

module.exports = commonUtils;