const { Server } = require('socket.io');
const settings = require('../config/settings');
const { isAllowedSocketOrigin } = require('../middleware/security');

// One place that builds the hardened Socket.IO server, shared by src/index.js and the tests.
module.exports = (httpServer) => new Server(httpServer, {
  cors: { origin: settings.corsOrigin, credentials: true },
  // Real payloads are under 200 bytes; the default 1 MB buffer lets a client make the server parse junk.
  maxHttpBufferSize: 16 * 1024,
  connectTimeout: 10000, // a client that opens a socket but never completes the handshake is dropped
  pingInterval: 20000,
  pingTimeout: 20000,
  // CORS only protects long-polling. WebSocket handshakes must be checked explicitly, or any web page could open an
  // authenticated socket with the visitor's cookies.
  allowRequest: (req, callback) => {
    callback(null, isAllowedSocketOrigin(req.headers.origin, req.headers.host));
  }
});
