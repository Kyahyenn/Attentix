const memoryState = require('../../src/state/memoryState');
const settings = require('../../src/config/settings');

describe('Memory State Management', () => {
  beforeEach(() => {
    memoryState.connections.clear();
    memoryState.classMetrics.clear();
  });

  test('should accurately aggregate live focus scores', () => {
    memoryState.registerConnection('socket_1', 'user_1', 'class_1', 'student');
    memoryState.registerConnection('socket_2', 'user_2', 'class_1', 'student');

    memoryState.updateMetric('socket_1', 80);
    memoryState.updateMetric('socket_2', 90);
    
    const avg = memoryState.getClassAverage('class_1');
    expect(avg).toBe(85);
  });

  test('should handle disconnected or stale clients gracefully', () => {
    memoryState.registerConnection('socket_3', 'user_3', 'class_2', 'student');
    memoryState.updateMetric('socket_3', 100);
    
    // Simulate time passing beyond the stale threshold
    const classMap = memoryState.classMetrics.get('class_2');
    const studentData = classMap.get('user_3');
    studentData.lastActive = Date.now() - (settings.staleTimeoutMs + 5000);
    
    const avg = memoryState.getClassAverage('class_2');
    expect(avg).toBe(0); // Stale metrics should not be included in the average
  });

  test('should drop stale client connections during cleanup', () => {
    memoryState.registerConnection('socket_4', 'user_4', 'class_3', 'student');
    
    const conn = memoryState.connections.get('socket_4');
    conn.lastActive = Date.now() - (settings.staleTimeoutMs + 5000);
    
    memoryState.cleanupStaleConnections();
    
    expect(memoryState.connections.has('socket_4')).toBe(false);
  });
});
describe('Memory State regression: live idle sockets and leaks', () => {
  beforeEach(() => {
    memoryState.connections.clear();
    memoryState.classMetrics.clear();
  });

  test('an idle but still-connected socket is NOT dropped when socket.io says it is alive', () => {
    memoryState.registerConnection('socket_idle', 'user_9', 'class_9', 'student');
    memoryState.connections.get('socket_idle').lastActive = Date.now() - (settings.staleTimeoutMs + 60000);

    memoryState.cleanupStaleConnections(() => true);

    expect(memoryState.connections.has('socket_idle')).toBe(true);
    expect(memoryState.updateMetric('socket_idle', 70)).toBe(true);
  });

  test('metrics silent for longer than the retention window are pruned, empty classes are removed', () => {
    memoryState.registerConnection('socket_a', 'user_a', 'class_a', 'student');
    memoryState.updateMetric('socket_a', 50);
    memoryState.removeConnection('socket_a');
    memoryState.classMetrics.get('class_a').get('user_a').lastActive = Date.now() - (settings.metricRetentionMs + 1000);

    memoryState.cleanupStaleConnections(() => true);

    expect(memoryState.classMetrics.has('class_a')).toBe(false);
  });

  test('updateMetric reports false for a socket that never joined a class', () => {
    expect(memoryState.updateMetric('ghost_socket', 10)).toBe(false);
  });
});
