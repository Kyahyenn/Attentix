/**
 * Socket.IO layer: handshake authentication, class rooms and all real-time events.
 *
 * Rooms per class: `<classId>` (everyone), `<classId>:educators`, `<classId>:students`, and
 * `<classId>:u:<studentId>` (one student's private channel).
 *
 * Client -> server: join_class, student:enterClass, educator:enterClass, student:activity, student:chatResponse,
 * educator:sendPrompt, educator:resetClass, attention_update (original protocol), attention:heartbeat (extension 2.x),
 * extension:event.
 *
 * The returned object lets REST routes disconnect or re-check live sockets.
 */
const memoryState = require('../state/memoryState');
const engagement = require('../state/engagementState');
const db = require('../config/db');
const settings = require('../config/settings');
const { isConsentCurrent } = require('../utils/consent');
const { z } = require('zod');
const { userFromToken } = require('../middleware/bearerAuth');
const { classNameOf, userDisplayName } = require('../utils/classes');

const MetricPayloadSchema = z.object({
  focusScore: z.number().min(0).max(100),
  // Sent by the Chrome extension; optional so the original `{ focusScore }` protocol still works.
  inputIdleMs: z.number().min(0).max(24 * 60 * 60 * 1000).nullable().optional(),
  state: z.enum(['meeting', 'tool', 'away']).optional()
});
// v2 heartbeat: one sample from the extension. `ageMs` is how long ago it was taken (0 live, larger when buffered during an
// outage); a relative age cannot be broken by a wrong clock.
const { MAX_BEAT_AGE_MS } = engagement.constants;
const MAX_BEATS_PER_BATCH = 5;
const HeartbeatSchema = z.object({
  score: z.number().min(0).max(100),
  state: z.enum(['Focused', 'Passive', 'Distracted', 'Idle']),
  location: z.enum(['meeting', 'tool', 'away']).optional(),
  isFocused: z.boolean(),
  idleSeconds: z.number().min(0).max(24 * 60 * 60).nullable().optional(),
  ageMs: z.number().min(0).max(MAX_BEAT_AGE_MS).optional()
});
const HeartbeatBatchSchema = z.object({ beats: z.array(HeartbeatSchema).min(1).max(MAX_BEATS_PER_BATCH) });
const ExtensionEventSchema = z.object({ type: z.enum(['tab-switch', 'chat-sent']) });
const ClassIdSchema = z.string().uuid();
// A closed list: a free-text field would let a client push arbitrary text into server state.
const ACTIVITY_TYPES = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click',
  'visibility-hidden', 'visibility-visible', 'blur', 'focus'];
const ActivitySchema = z.object({ eventType: z.enum(ACTIVITY_TYPES), tabHidden: z.boolean() });
const ChatResponseSchema = z.object({ response: z.string().trim().min(1).max(500) });
const PromptSchema = z.object({ classId: ClassIdSchema, text: z.string().trim().min(1).max(300) });
const ClassPayloadSchema = z.object({ classId: ClassIdSchema });

const MIN_BROADCAST_INTERVAL_MS = 1000; // per class

// Clients may omit the acknowledgement callback; replying to nobody is then a no-op.
const ackOrNoop = (ack) => (typeof ack === 'function' ? ack : () => {});

/**
 * A user may only enter a class they own (educator) or are enrolled in AND have consented to (student).
 * Resolves to { ok: true, klass } or { ok: false, error }. Used on every entry, by the revalidation timer and by REST heartbeats.
 */
const authorizeClassAccess = async (user, classId) => {
  const klass = await db.findById('classes', classId);
  if (!klass) return { ok: false, error: 'Class not found' };

  if (user.role === 'educator') {
    return klass.educatorId === user.id
      ? { ok: true, klass }
      : { ok: false, error: 'You do not teach this class' };
  }

  const [enrollments, consents] = await Promise.all([db.readData('enrollments'), db.readData('consents')]);
  if (!enrollments.some((e) => e.classId === classId && e.studentId === user.id)) {
    return { ok: false, error: 'You are not enrolled in this class' };
  }
  // Consent must be a current "yes" to the current version of the agreement.
  const consent = consents.find((c) => c.userId === user.id);
  if (!isConsentCurrent(consent)) {
    return { ok: false, error: 'Monitoring consent is required before joining' };
  }
  return { ok: true, klass };
};

// Tiny sliding-window limiter, one instance per socket: stops a single client from flooding a handler.
const makeAllow = () => {
  const hits = new Map();
  return (name, max, windowMs) => {
    const now = Date.now();
    const recent = (hits.get(name) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { hits.set(name, recent); return false; }
    recent.push(now);
    hits.set(name, recent);
    return true;
  };
};

module.exports = (io) => {
  const socketsByUser = new Map(); // userId -> number of open sockets

  // Rejecting in middleware makes the browser fire `connect_error` (the pages already handle it); disconnecting after
  // connect left the client silently dead. Two ways in: the cookie session (web pages) or a bearer token in `auth` (extension).
  io.use((socket, next) => {
    const session = socket.request && socket.request.session;
    socket.data = socket.data || {};

    const accept = (user, extra) => {
      if ((socketsByUser.get(user.id) || 0) >= settings.maxSocketsPerUser) return next(new Error('Too many open connections'));
      socket.data.user = user;
      Object.assign(socket.data, extra);
      return next();
    };

    if (session && session.user) return accept(session.user, { sessionId: socket.request.sessionID || null });

    const token = socket.handshake && socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));

    userFromToken(token)
      .then((user) => (user ? accept(user, { viaToken: true }) : next(new Error('Authentication required'))))
      .catch(() => next(new Error('Authentication required')));
  });

  const lastBroadcastByClass = new Map();
  const lastClassUpdateByClass = new Map();
  const educatorSockets = new Map(); // classId -> Set(socketId) of educators with that class open

  // Per-student rows for the educator dashboard (`class:update`), educators only. Throttled to one per second per class;
  // a throttled update is flushed when the window ends, so the dashboard never stays stale.
  const pendingFlush = new Map();
  const broadcastClass = (classId, force = false) => {
    const now = Date.now();
    const wait = MIN_BROADCAST_INTERVAL_MS - (now - (lastClassUpdateByClass.get(classId) || 0));
    if (!force && wait > 0) {
      if (!pendingFlush.has(classId)) {
        const timer = setTimeout(() => { pendingFlush.delete(classId); broadcastClass(classId, true); }, wait);
        if (timer.unref) timer.unref();
        pendingFlush.set(classId, timer);
      }
      return;
    }
    lastClassUpdateByClass.set(classId, now);
    const students = engagement.snapshot(classId, now);
    io.to(`${classId}:educators`).emit('class:update', { classId, students, timestamp: now });

    // Transparency: every online student is shown, live, exactly the row their educator sees for them (and only theirs).
    for (const row of students) {
      if (!row.online) continue;
      const { studentId, name, ...view } = row;
      io.to(`${classId}:u:${studentId}`).emit('student:self', { classId, status: view, timestamp: now });
    }
  };

  // `class_average_update` (everyone sees only the average) and `class_detailed_telemetry` (educators only), at most once per second.
  const emitClassAggregates = (classId, now = Date.now()) => {
    const lastBroadcast = lastBroadcastByClass.get(classId) || 0;
    if (now - lastBroadcast < MIN_BROADCAST_INTERVAL_MS) return;
    lastBroadcastByClass.set(classId, now);
    io.to(classId).emit('class_average_update', {
      classId,
      averageScore: memoryState.getClassAverage(classId),
      timestamp: now
    });
    io.to(`${classId}:educators`).emit('class_detailed_telemetry', {
      classId,
      details: memoryState.getDetailedClassMetrics(classId),
      timestamp: now
    });
  };

  // The one place v2 heartbeats are applied, from the socket or REST: updates the smoothed score, counters and history, then
  // pushes the result to the educators' room and the student's own room. Returns { ok, accepted, status }.
  const ingestHeartbeats = (user, classId, beats, { rest = false } = {}) => {
    const now = Date.now();
    const accepted = engagement.recordHeartbeats(classId, user, beats, now, { rest });
    const status = engagement.selfView(classId, user.id, now);
    if (accepted > 0 && status) {
      memoryState.setMetric(classId, user.id, status.focusScore);
      broadcastClass(classId);
      emitClassAggregates(classId, now);
    }
    return { ok: true, accepted, status };
  };

  // REST heartbeats have no socket to remember the join, so access is re-checked against the database and cached briefly.
  const REST_ACCESS_TTL_MS = 30 * 1000;
  const restAccess = new Map(); // `${userId}:${classId}` -> { ok, error, until }
  const restAccessFor = async (user, classId) => {
    const key = `${user.id}:${classId}`;
    const hit = restAccess.get(key);
    if (hit && hit.until > Date.now()) return hit;
    const access = await authorizeClassAccess(user, classId);
    const entry = { ok: access.ok, error: access.error, until: Date.now() + REST_ACCESS_TTL_MS };
    restAccess.set(key, entry);
    if (restAccess.size > 5000) for (const [k, v] of restAccess) if (v.until < Date.now()) restAccess.delete(k);
    return entry;
  };

  const purgeRestAccess = (userId) => { for (const key of restAccess.keys()) if (key.startsWith(`${userId}:`)) restAccess.delete(key); };

  const trackEducator = (classId, socketId) => {
    if (!educatorSockets.has(classId)) educatorSockets.set(classId, new Set());
    educatorSockets.get(classId).add(socketId);
  };
  const untrackEducator = (classId, socketId) => {
    const set = educatorSockets.get(classId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) educatorSockets.delete(classId);
  };

  // ---- per-socket event handlers ----
  // Each register* function attaches one group of events to a connection { socket, user, allow }.

  // Entering a class: `join_class` (extension / original protocol), `student:enterClass`, `educator:enterClass`.
  const registerClassEntry = ({ socket, user, allow }) => {
    const { id: userId, role } = user;

    // Checks access, moves the socket into the class's rooms (leaving a previous class first) and registers it.
    // Resolves to { ok, ... } for the acknowledgement, or null when the socket dropped while the database was queried.
    const enterClass = async (rawClassId) => {
      const parsed = ClassIdSchema.safeParse(rawClassId);
      if (!parsed.success) return { ok: false, error: 'Invalid class id' };
      const classId = parsed.data;

      const access = await authorizeClassAccess(user, classId);
      if (!access.ok) return { ok: false, error: access.error };

      // The socket may have dropped while we were awaiting the database; don't register a ghost connection.
      if (socket.disconnected) return null;

      const previous = memoryState.connections.get(socket.id);
      const switching = previous && previous.classId !== classId;
      if (switching) {
        socket.leave(previous.classId);
        socket.leave(`${previous.classId}:educators`);
        socket.leave(`${previous.classId}:students`);
        socket.leave(`${previous.classId}:u:${userId}`);
        if (previous.role === 'student') engagement.disconnect(previous.classId, userId);
        else untrackEducator(previous.classId, socket.id);
      }

      socket.join(classId);
      if (role === 'educator') socket.join(`${classId}:educators`);
      else { socket.join(`${classId}:students`); socket.join(`${classId}:u:${userId}`); }
      memoryState.registerConnection(socket.id, userId, classId, role);

      if (!previous || switching) {
        if (role === 'student') engagement.connect(classId, user);
        else trackEducator(classId, socket.id);
      }

      const educatorName = access.klass.educatorId === userId
        ? (user.name || user.legalName)
        : await userDisplayName(access.klass.educatorId);

      if (role === 'student') broadcastClass(classId, true);
      return { ok: true, classId, className: classNameOf(access.klass), educatorName: educatorName || 'Educator' };
    };

    const handleEnter = (expectedRole, extract) => async (payload, ack) => {
      const reply = ackOrNoop(ack);
      try {
        if (!allow('enter', 10, 10000)) return reply({ ok: false, error: 'Too many requests. Wait a moment.' });
        if (expectedRole && role !== expectedRole) return reply({ ok: false, error: `${expectedRole} account required` });
        const result = await enterClass(extract(payload));
        if (result === null) return;
        reply(result);
        if (result.ok && role === 'educator') broadcastClass(result.classId, true);
      } catch (err) {
        console.error('enter class failed:', err);
        reply({ ok: false, error: 'Unable to join class' });
      }
    };

    socket.on('join_class', handleEnter(null, (raw) => raw));
    socket.on('student:enterClass', handleEnter('student', (p) => p && p.classId));
    socket.on('educator:enterClass', handleEnter('educator', (p) => p && p.classId));
  };

  // Web student page: activity events and chat answers.
  const registerStudentPageEvents = ({ socket, user, allow }) => {
    socket.on('student:activity', (payload) => {
      if (!allow('activity', 10, 1000)) return;
      const conn = memoryState.connections.get(socket.id);
      if (!conn || conn.role !== 'student') return;
      const parsed = ActivitySchema.safeParse(payload);
      if (!parsed.success) return;
      engagement.recordActivity(conn.classId, user, parsed.data.eventType, parsed.data.tabHidden);
      broadcastClass(conn.classId);
    });

    socket.on('student:chatResponse', (payload, ack) => {
      const reply = ackOrNoop(ack);
      if (!allow('chat', 5, 10000)) return reply({ ok: false, error: 'You are sending too fast. Wait a moment.' });
      const conn = memoryState.connections.get(socket.id);
      if (!conn || conn.role !== 'student') return reply({ ok: false, error: 'Join a class first.' });
      const parsed = ChatResponseSchema.safeParse(payload);
      if (!parsed.success) return reply({ ok: false, error: 'Write a response between 1 and 500 characters.' });
      engagement.recordChatResponse(conn.classId, user);
      broadcastClass(conn.classId, true);
      reply({ ok: true });
    });
  };

  // Educator actions on a class they teach: ask a question, clear the live picture.
  const registerEducatorEvents = ({ socket, user, allow }) => {
    const { role } = user;

    socket.on('educator:sendPrompt', async (payload, ack) => {
      const reply = ackOrNoop(ack);
      try {
        if (role !== 'educator') return reply({ ok: false, error: 'Educator account required' });
        if (!allow('prompt', 5, 10000)) return reply({ ok: false, error: 'You are sending too fast. Wait a moment.' });
        const parsed = PromptSchema.safeParse(payload);
        if (!parsed.success) return reply({ ok: false, error: 'Write a question between 1 and 300 characters.' });
        const { classId, text } = parsed.data;
        const access = await authorizeClassAccess(user, classId);
        if (!access.ok) return reply({ ok: false, error: access.error });
        engagement.recordPrompt(classId);
        io.to(`${classId}:students`).emit('chat:prompt', { text });
        broadcastClass(classId, true);
        reply({ ok: true });
      } catch (err) {
        console.error('sendPrompt failed:', err);
        reply({ ok: false, error: 'Could not send the prompt.' });
      }
    });

    // Data minimisation: lets an educator wipe the live picture (counters, scores, offline students) between lessons.
    socket.on('educator:resetClass', async (payload, ack) => {
      const reply = ackOrNoop(ack);
      try {
        if (role !== 'educator') return reply({ ok: false, error: 'Educator account required' });
        const parsed = ClassPayloadSchema.safeParse(payload);
        if (!parsed.success) return reply({ ok: false, error: 'Invalid class id' });
        const access = await authorizeClassAccess(user, parsed.data.classId);
        if (!access.ok) return reply({ ok: false, error: access.error });
        engagement.resetClass(parsed.data.classId);
        memoryState.clearClass(parsed.data.classId);
        broadcastClass(parsed.data.classId, true);
        reply({ ok: true });
      } catch (err) {
        console.error('resetClass failed:', err);
        reply({ ok: false, error: 'Could not clear the live data.' });
      }
    });
  };

  // Chrome extension telemetry: the original `attention_update` score, v2 heartbeats, and discrete events.
  const registerExtensionEvents = ({ socket, user, allow }) => {
    let lastUpdateAt = 0;
    let lastExtensionEventAt = 0;

    socket.on('attention_update', (payload) => {
      try {
        const now = Date.now();
        if (now - lastUpdateAt < 500) return; // drop floods from a single client
        lastUpdateAt = now;

        const { focusScore, inputIdleMs, state } = MetricPayloadSchema.parse(payload);
        if (!memoryState.updateMetric(socket.id, focusScore)) {
          return socket.emit('error', { message: 'Join a class before sending metrics' });
        }

        const conn = memoryState.connections.get(socket.id);
        if (!conn || !conn.classId) return;

        engagement.recordScore(conn.classId, user, focusScore, now, { inputIdleMs, state });
        broadcastClass(conn.classId);

        emitClassAggregates(conn.classId, now);
      } catch {
        socket.emit('error', { message: 'Invalid metric payload' });
      }
    });

    // 1-5 beats per message (more when buffered during an outage). Acknowledged, so the client knows when to drop its buffer.
    socket.on('attention:heartbeat', (payload, ack) => {
      const reply = ackOrNoop(ack);
      if (!allow('heartbeat', 10, 10000)) return reply({ ok: false, error: 'Too many heartbeats. Slow down.' });
      const conn = memoryState.connections.get(socket.id);
      if (!conn || conn.role !== 'student') return reply({ ok: false, code: 'not_joined', error: 'Join a class before sending metrics' });
      const parsed = HeartbeatBatchSchema.safeParse(payload);
      if (!parsed.success) return reply({ ok: false, code: 'invalid', error: 'Invalid heartbeat' });
      reply(ingestHeartbeats(user, conn.classId, parsed.data.beats));
    });

    // Tab switch / chat message sent: only the fact is reported, never any content.
    socket.on('extension:event', (payload) => {
      const conn = memoryState.connections.get(socket.id);
      if (!conn || conn.role !== 'student') return;
      const now = Date.now();
      if (now - lastExtensionEventAt < 250) return; // a client cannot flood the counters
      const parsed = ExtensionEventSchema.safeParse(payload);
      if (!parsed.success) return;
      lastExtensionEventAt = now;
      if (parsed.data.type === 'tab-switch') engagement.recordTabSwitch(conn.classId, user, now);
      else engagement.recordMeetingChat(conn.classId, user, now);
      broadcastClass(conn.classId, true);
    });
  };

  const registerDisconnect = ({ socket, user }) => {
    socket.on('disconnect', () => {
      const remaining = (socketsByUser.get(user.id) || 1) - 1;
      if (remaining <= 0) socketsByUser.delete(user.id); else socketsByUser.set(user.id, remaining);

      const conn = memoryState.connections.get(socket.id);
      if (conn && conn.role === 'student') {
        engagement.disconnect(conn.classId, user.id);
        broadcastClass(conn.classId, true);
      } else if (conn && conn.role === 'educator') {
        untrackEducator(conn.classId, socket.id);
      }
      memoryState.removeConnection(socket.id);
    });
  };

  io.on('connection', (socket) => {
    const user = (socket.data && socket.data.user) || (socket.request.session && socket.request.session.user);

    if (!user) {
      socket.disconnect(true);
      return;
    }

    socketsByUser.set(user.id, (socketsByUser.get(user.id) || 0) + 1);
    const context = { socket, user, allow: makeAllow() };
    registerClassEntry(context);
    registerStudentPageEvents(context);
    registerEducatorEvents(context);
    registerExtensionEvents(context);
    registerDisconnect(context);
  });

  // ---- server-side control: used by the REST routes and the revalidation timer ----
  const liveSockets = () => (io.sockets && io.sockets.sockets ? [...io.sockets.sockets.values()] : []);

  const kick = (socket, reason) => {
    socket.emit('session:revoked', { reason });
    socket.disconnect(true);
  };

  const kickWhere = (predicate, reason) => {
    let count = 0;
    for (const socket of liveSockets()) {
      if (predicate(socket)) { kick(socket, reason); count += 1; }
    }
    return count;
  };

  return {
    // REST twin of `attention:heartbeat` (POST /api/extension/heartbeat). `user` comes from the bearer token and is bound to one
    // class. Resolves to { ok, accepted, status } or { ok: false, status: <http>, error }.
    ingestHeartbeat: async (user, payload) => {
      if (!user || user.role !== 'student' || !user.classId) return { ok: false, status: 403, error: 'Student token required' };
      const parsed = HeartbeatBatchSchema.safeParse(payload);
      if (!parsed.success) return { ok: false, status: 400, error: 'Invalid heartbeat' };
      const access = await restAccessFor(user, user.classId);
      if (!access.ok) return { ok: false, status: 403, error: access.error };
      return ingestHeartbeats(user, user.classId, parsed.data.beats, { rest: true });
    },

    // Time-based facts (idle seconds, unanswered prompt) change without any event, so open dashboards get a refresh.
    refreshEducatorViews: () => { for (const classId of educatorSockets.keys()) broadcastClass(classId, true); },

    // Cuts live connections of a user. opts.classId: only that class. opts.tokenOnly: only extension sockets.
    disconnectUser: (userId, reason, opts = {}) => { purgeRestAccess(userId); return kickWhere((s) => {
      if (!s.data || !s.data.user || s.data.user.id !== userId) return false;
      if (opts.tokenOnly && !s.data.viaToken) return false;
      if (opts.classId) {
        const conn = memoryState.connections.get(s.id);
        if (!conn || conn.classId !== opts.classId) return false;
      }
      return true;
    }, reason); },

    // Logout: a destroyed cookie session must also end the sockets that were opened with it.
    disconnectSession: (sessionId, reason) => kickWhere((s) => Boolean(sessionId) && s.data && s.data.sessionId === sessionId, reason),

    // Removes a user's live data (consent withdrawn, account deleted) and refreshes the affected dashboards.
    forgetUser: (userId, onlyClassId = null) => {
      purgeRestAccess(userId);   // a REST-only student must be refused on the very next heartbeat, not 30 s later
      const classIds = engagement.forgetUser(userId, onlyClassId);
      memoryState.forgetUser(userId);
      classIds.forEach((classId) => broadcastClass(classId, true));
    },

    // Cuts every live connection to one class (the class was deleted along with its educator's account).
    closeClass: (classId, reason) => kickWhere((s) => {
      const conn = memoryState.connections.get(s.id);
      return Boolean(conn) && conn.classId === classId;
    }, reason),

    // Re-checks every live socket against the database. A student who withdrew consent, was removed from the class
    // or whose account no longer exists is disconnected even if no route did it explicitly.
    revalidate: async () => {
      for (const socket of liveSockets()) {
        const user = socket.data && socket.data.user;
        const conn = memoryState.connections.get(socket.id);
        if (!user || !conn) continue;
        try {
          if (!(await db.findById('users', user.id))) { kick(socket, 'This account no longer exists.'); continue; }
          const access = await authorizeClassAccess(user, conn.classId);
          if (!access.ok) kick(socket, access.error);
        } catch (err) {
          console.error('revalidate failed:', err);
        }
      }
    }
  };
};
