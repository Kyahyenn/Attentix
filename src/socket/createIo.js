const { Server } = require('socket.io');
const settings = require('../config/settings');
const { isAllowedSocketOrigin } = require('../middleware/security');

// One place that builds the hardened Socket.IO server, shared by src/index.js and the tests.
module.exports = (httpServer) => new Server(httpServer, {
  cors: { origin: settings.corsOrigin, credentials: true },
  // Real payloads are < 200 bytes. The default 1 MB buffer lets one client make the server allocate and parse junk.
  maxHttpBufferSize: 16 * 1024,
  connectTimeout: 10000, // a client that opens a socket but never completes the handshake is dropped
  pingInterval: 20000,
  pingTimeout: 20000,
  // CORS headers only protect the HTTP long-polling transport. WebSocket handshakes must be checked explicitly,
  // otherwise any web page could open an authenticated socket using the visitor's cookies.
  allowRequest: (req, callback) => {
    callback(null, isAllowedSocketOrigin(req.headers.origin, req.headers.host));
  }
});
