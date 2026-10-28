const socketHandler = require('../../src/socket/socketHandler');
const memoryState = require('../../src/state/memoryState');
const db = require('../../src/config/db');
const { issueStudentToken, TOKEN_TTL_MS } = require('../../src/utils/extensionToken');
const engagement = require('../../src/state/engagementState');

const CLASS_ID = '11111111-1111-4111-8111-111111111111';

jest.mock('../../src/config/db', () => ({
  findById: jest.fn(),
  readData: jest.fn()
}));

jest.mock('../../src/state/memoryState', () => ({
  registerConnection: jest.fn(),
  updateMetric: jest.fn().mockReturnValue(true),
  setMetric: jest.fn(),
  removeConnection: jest.fn(),
  getClassAverage: jest.fn().mockReturnValue(85),
  getDetailedClassMetrics: jest.fn().mockReturnValue([]),
  connections: new Map([
    ['mock_socket_id', { classId: '11111111-1111-4111-8111-111111111111', role: 'student', userId: 'user_1' }]
  ])
}));

describe('WebSocket Handler', () => {
  let mockIo;
  let mockSocket;
  let middleware;

  const handlerFor = (event) => mockSocket.on.mock.calls.find((call) => call[0] === event)[1];

  beforeEach(() => {
    jest.clearAllMocks();
    memoryState.updateMetric.mockReturnValue(true);

    mockSocket = {
      id: 'mock_socket_id',
      disconnected: false,
      request: { session: { user: { id: 'user_1', role: 'student' } } },
      join: jest.fn(),
      leave: jest.fn(),
      on: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn()
    };

    mockIo = {
      use: jest.fn((fn) => { middleware = fn; }),
      on: jest.fn((event, cb) => { if (event === 'connection') cb(mockSocket); }),
      to: jest.fn().mockReturnThis(),
      emit: jest.fn()
    };

    db.findById.mockResolvedValue({ id: CLASS_ID, className: 'Math', educatorId: 'teacher_1' });
    db.readData.mockImplementation(async (collection) => {
      if (collection === 'enrollments') return [{ classId: CLASS_ID, studentId: 'user_1' }];
      if (collection === 'consents') return [{ userId: 'user_1', agreedToMonitoring: true, version: require('../../src/config/settings').consentVersion }];
      return [];
    });
  });

  test('handshake middleware rejects sockets with no authenticated session', () => {
    socketHandler(mockIo);
    const next = jest.fn();
    middleware({ request: { session: null } }, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Authentication required' }));
  });

  test('should disconnect socket immediately if no authenticated session exists', () => {
    mockSocket.request.session = null;
    socketHandler(mockIo);
    expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
  });

  test('enrolled + consenting student can join their class', async () => {
    socketHandler(mockIo);
    const ack = jest.fn();
    await handlerFor('join_class')(CLASS_ID, ack);

    expect(mockSocket.join).toHaveBeenCalledWith(CLASS_ID);
    expect(memoryState.registerConnection).toHaveBeenCalledWith('mock_socket_id', 'user_1', CLASS_ID, 'student');
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true, className: 'Math' }));
  });

  test('student NOT enrolled in the class is refused', async () => {
    db.readData.mockImplementation(async (collection) =>
      collection === 'consents' ? [{ userId: 'user_1', agreedToMonitoring: true, version: require('../../src/config/settings').consentVersion }] : []);
    socketHandler(mockIo);
    const ack = jest.fn();
    await handlerFor('join_class')(CLASS_ID, ack);

    expect(mockSocket.join).not.toHaveBeenCalled();
    expect(memoryState.registerConnection).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'You are not enrolled in this class' });
  });

  test('student without monitoring consent is refused', async () => {
    db.readData.mockImplementation(async (collection) =>
      collection === 'enrollments' ? [{ classId: CLASS_ID, studentId: 'user_1' }] : []);
    socketHandler(mockIo);
    const ack = jest.fn();
    await handlerFor('join_class')(CLASS_ID, ack);

    expect(mockSocket.join).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  test('educator cannot join a class they do not teach; malformed ids never reach the database', async () => {
    mockSocket.request.session.user = { id: 'teacher_2', role: 'educator' };
    socketHandler(mockIo);

    const denied = jest.fn();
    await handlerFor('join_class')(CLASS_ID, denied);
    expect(denied).toHaveBeenCalledWith({ ok: false, error: 'You do not teach this class' });

    db.findById.mockClear();
    const invalid = jest.fn();
    await handlerFor('join_class')({ $ne: null }, invalid);
    expect(invalid).toHaveBeenCalledWith({ ok: false, error: 'Invalid class id' });
    expect(db.findById).not.toHaveBeenCalled();
  });

  test('valid attention_update broadcasts the average to the class and telemetry ONLY to the educator room', () => {
    socketHandler(mockIo);
    handlerFor('attention_update')({ focusScore: 95 });

    expect(memoryState.updateMetric).toHaveBeenCalledWith('mock_socket_id', 95);
    expect(mockIo.to).toHaveBeenCalledWith(CLASS_ID);
    expect(mockIo.to).toHaveBeenCalledWith(`${CLASS_ID}:educators`);
    expect(mockIo.emit).toHaveBeenCalledWith('class_average_update', expect.objectContaining({ averageScore: 85 }));
    expect(mockIo.emit).toHaveBeenCalledWith('class_detailed_telemetry', expect.any(Object));
  });

  test('invalid payload is rejected with an error event', () => {
    socketHandler(mockIo);
    handlerFor('attention_update')({ focusScore: 'NaN' });
    expect(mockSocket.emit).toHaveBeenCalledWith('error', { message: 'Invalid metric payload' });
  });

  describe('passwordless students (bearer token in the socket handshake)', () => {
    const student = { id: 'user_1', role: 'student', name: 'Ana Cruz', email: 'ana@pup.edu.ph', classId: CLASS_ID, tokenVersion: 0 };
    const klass = { id: CLASS_ID, classCode: 'ABC234', className: 'Math', educatorId: 'teacher_1' };
    const handshake = (token) => ({ request: { session: null }, handshake: { auth: { token } }, data: {} });
    const withDb = (users) => db.findById.mockImplementation(async (collection, id) => (collection === 'users' ? users[id] : klass));
    // The handshake middleware is callback-style: resolve with whatever it passes to next().
    const runHandshake = (socket) => new Promise((resolve) => middleware(socket, (err) => resolve(err)));
    beforeEach(() => { engagement.forgetUser('user_1'); engagement.resetClass(CLASS_ID); }); // the real live state is a shared singleton

    test('a valid token authenticates the socket as that student, with no cookie session', async () => {
      withDb({ user_1: student });
      socketHandler(mockIo);
      const socket = handshake(issueStudentToken(student, klass));
      expect(await runHandshake(socket)).toBeUndefined();
      expect(socket.data.user).toMatchObject({ id: 'user_1', role: 'student' });
    });

    test.each([
      ['a forged token', () => 'forged.token'],
      ['an expired token', () => issueStudentToken(student, klass, Date.now() - TOKEN_TTL_MS - 1000)],
      ['a token for a deleted student', () => issueStudentToken({ ...student, id: 'gone' }, klass)],
      ['a token from before "sign out everywhere"', () => issueStudentToken({ ...student, tokenVersion: 0 }, klass)]
    ])('%s is refused with "Authentication required"', async (label, makeToken) => {
      withDb({ user_1: label.includes('everywhere') ? { ...student, tokenVersion: 1 } : student });
      socketHandler(mockIo);
      expect(await runHandshake(handshake(makeToken()))).toEqual(expect.objectContaining({ message: 'Authentication required' }));
    });

    test('attention:heartbeat is scored on the server and broadcast: educators get the row, the student only their own', async () => {
      jest.useFakeTimers(); // class rows are throttled to one per second per class; advance past the window instead of sleeping
      try {
        socketHandler(mockIo);
        await handlerFor('join_class')(CLASS_ID, jest.fn());
        // The shared mock already lists this socket as connected, so enterClass skips the first-join presence step.
        engagement.connect(CLASS_ID, student);

        const ack = jest.fn();
        await handlerFor('attention:heartbeat')({ beats: [{ score: 77, state: 'Focused', location: 'meeting', isFocused: true, idleSeconds: 1 }] }, ack);
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true, accepted: 1, status: expect.objectContaining({ focusScore: 77, attentionState: 'Focused' }) }));
        expect(memoryState.setMetric).toHaveBeenCalledWith(CLASS_ID, 'user_1', 77);
        jest.advanceTimersByTime(1100);

        const lastOf = (evt) => mockIo.emit.mock.calls.filter(([e]) => e === evt).pop();
        expect(lastOf('class:update')[1].students[0]).toMatchObject({ studentId: 'user_1', name: 'Ana Cruz', online: true, focusScore: 77, attentive: true });
        expect(mockIo.to).toHaveBeenCalledWith(`${CLASS_ID}:educators`);
        expect(mockIo.to).toHaveBeenCalledWith(`${CLASS_ID}:u:user_1`);
        const self = lastOf('student:self')[1];
        expect(self.status.focusScore).toBe(77);
        expect(self.status.studentId).toBeUndefined();
        expect(self.status.name).toBeUndefined();
        expect(mockIo.emit).toHaveBeenCalledWith('class_average_update', expect.objectContaining({ classId: CLASS_ID, averageScore: 85 }));
      } finally {
        jest.useRealTimers();
      }
    });

    test('a malformed heartbeat is refused and changes nothing', async () => {
      socketHandler(mockIo);
      await handlerFor('join_class')(CLASS_ID, jest.fn());
      memoryState.setMetric.mockClear();
      const ack = jest.fn();
      await handlerFor('attention:heartbeat')({ beats: [{ score: 500, state: 'Focused', location: 'meeting', isFocused: true }] }, ack);
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'invalid' }));
      expect(memoryState.setMetric).not.toHaveBeenCalled();
    });
  });
});
