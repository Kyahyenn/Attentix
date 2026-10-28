const settings = require('../config/settings');

class MemoryState {
  constructor() {
    this.connections = new Map(); // socketId -> { userId, classId, role, lastActive }
    this.classMetrics = new Map(); // classId -> Map(studentId -> { score, lastActive })
  }

  registerConnection(socketId, userId, classId, role) {
    this.connections.set(socketId, {
      userId,
      classId,
      role,
      lastActive: Date.now()
    });

    if (!this.classMetrics.has(classId)) {
      this.classMetrics.set(classId, new Map());
    }
  }

  removeConnection(socketId) {
    // Kept for a while so brief network blips do not erase a student; pruned by cleanupStaleConnections().
    this.connections.delete(socketId);
  }

  // Returns true when the metric was stored, false when the socket never joined a class (or isn't a student).
  updateMetric(socketId, focusScore) {
    const conn = this.connections.get(socketId);
    if (!conn || conn.role !== 'student') return false;

    const classMap = this.classMetrics.get(conn.classId);
    if (!classMap) return false;

    const now = Date.now();
    conn.lastActive = now;
    classMap.set(conn.userId, { score: focusScore, lastActive: now });
    return true;
  }

  // Stores a student's (smoothed) score by user id. Used by v2 heartbeats, which may arrive over REST with no socket.
  setMetric(classId, userId, score) {
    if (!this.classMetrics.has(classId)) this.classMetrics.set(classId, new Map());
    this.classMetrics.get(classId).set(userId, { score, lastActive: Date.now() });
  }

  forgetUser(userId) {
    for (const classMap of this.classMetrics.values()) classMap.delete(userId);
  }

  clearClass(classId) {
    const classMap = this.classMetrics.get(classId);
    if (classMap) classMap.clear();
  }

  getClassAverage(classId) {
    const classMap = this.classMetrics.get(classId);
    if (!classMap || classMap.size === 0) return 0;

    let total = 0;
    let activeCount = 0;
    const now = Date.now();

    for (const data of classMap.values()) {
      if (now - data.lastActive < settings.staleTimeoutMs) {
        total += data.score;
        activeCount++;
      }
    }

    return activeCount === 0 ? 0 : Math.round(total / activeCount);
  }

  getDetailedClassMetrics(classId) {
    const classMap = this.classMetrics.get(classId);
    if (!classMap) return [];

    const now = Date.now();
    const result = [];

    for (const [studentId, data] of classMap.entries()) {
      const isStale = (now - data.lastActive) >= settings.staleTimeoutMs;
      result.push({
        studentId,
        score: isStale ? 0 : data.score,
        status: isStale ? 'disconnected' : 'active'
      });
    }
    return result;
  }

  /**
   * @param {(socketId: string) => boolean} [isSocketAlive] When given, socket.io decides liveness, so a connected-but-idle
   * student is never dropped. Without it, a connection silent for `staleTimeoutMs` counts as dead.
   */
  cleanupStaleConnections(isSocketAlive) {
    const now = Date.now();

    for (const [socketId, conn] of this.connections.entries()) {
      const dead = typeof isSocketAlive === 'function'
        ? !isSocketAlive(socketId)
        : now - conn.lastActive >= settings.staleTimeoutMs;
      if (dead) this.connections.delete(socketId);
    }

    // Bound classMetrics: prune silent students and classes nobody is connected to.
    const activeClassIds = new Set([...this.connections.values()].map((c) => c.classId));
    for (const [classId, classMap] of this.classMetrics.entries()) {
      for (const [studentId, data] of classMap.entries()) {
        if (now - data.lastActive >= settings.metricRetentionMs) classMap.delete(studentId);
      }
      if (classMap.size === 0 && !activeClassIds.has(classId)) this.classMetrics.delete(classId);
    }
  }
}

module.exports = new MemoryState();
